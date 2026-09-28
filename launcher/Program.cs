using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Executable path is unavailable");
            var digest = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(executable)))[..12].ToLowerInvariant();
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexUsageOverlay", "runtime", digest);
            Directory.CreateDirectory(root);
            var assembly = Assembly.GetExecutingAssembly();
            foreach (var name in assembly.GetManifestResourceNames())
            {
                string? relative = name switch
                {
                    "runtime.node.exe" => "node.exe",
                    _ when name.StartsWith("src.", StringComparison.Ordinal) => Path.Combine("src", name[4..]),
                    _ => null,
                };
                if (relative is null) continue;
                var destination = Path.Combine(root, relative);
                if (File.Exists(destination)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                var temporary = destination + "." + Environment.ProcessId + ".tmp";
                using (var input = assembly.GetManifestResourceStream(name)!)
                using (var output = File.Create(temporary)) input.CopyTo(output);
                try { File.Move(temporary, destination); }
                catch (IOException) when (File.Exists(destination)) { File.Delete(temporary); }
            }

            if (args.Contains("--self-test"))
            {
                var required = new[] { "main.mjs", "widget-overlay.mjs", "placement.mjs", "quota-estimator.mjs", "hook-client.mjs" };
                var okay = File.Exists(Path.Combine(root, "node.exe")) && required.All(file => File.Exists(Path.Combine(root, "src", file)));
                File.WriteAllText(Path.Combine(root, "self-test.txt"), okay ? "ok" : "missing embedded files");
                return okay ? 0 : 2;
            }

            var node = Path.Combine(root, "node.exe");
            var script = Path.Combine(root, "src", args.Contains("--hook-client") ? "hook-client.mjs" : "main.mjs");
            var hook = args.Contains("--hook-client");
            var start = new ProcessStartInfo(node) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true };
            start.ArgumentList.Add(script);
            foreach (var arg in args.Where(arg => arg != "--hook-client")) start.ArgumentList.Add(arg);
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = System.Text.Encoding.UTF8;
            start.StandardErrorEncoding = System.Text.Encoding.UTF8;
            start.RedirectStandardInput = hook;
            using var child = Process.Start(start) ?? throw new InvalidOperationException("Could not start bundled Node runtime");
            if (hook)
            {
                child.StandardInput.Write(Console.In.ReadToEnd());
                child.StandardInput.Close();
                Console.Out.Write(child.StandardOutput.ReadToEnd());
                child.StandardError.ReadToEnd();
                child.WaitForExit();
                return child.ExitCode;
            }

            // The writer has to stay alive until WaitForExit returns: the asynchronous readers keep
            // raising events after the child exits, and writing to a disposed writer crashes the launcher.
            var logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexUsageOverlay", "launcher.log");
            using var log = new StreamWriter(logPath, append: true) { AutoFlush = true };
            log.WriteLine($"[{DateTimeOffset.Now:O}] Started PID {child.Id}");
            child.OutputDataReceived += (_, eventArgs) => { if (eventArgs.Data != null) lock (log) log.WriteLine(eventArgs.Data); };
            child.ErrorDataReceived += (_, eventArgs) => { if (eventArgs.Data != null) lock (log) log.WriteLine(eventArgs.Data); };
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            child.WaitForExit();
            return child.ExitCode;
        }
        catch (Exception error)
        {
            try
            {
                var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexUsageOverlay", "launcher-error.log");
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.AppendAllText(path, $"[{DateTimeOffset.Now:O}] {error}\n");
            }
            catch { /* The launcher has no usable log directory. */ }
            return 1;
        }
    }
}
