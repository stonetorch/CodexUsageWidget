using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;

internal static class Program
{
    // Codex reviews a hook against its command path, so the runtime directory has to stay put: a
    // directory named after the executable hash would make every rebuild look like a brand new
    // hook and cost the user another trust prompt. Files are refreshed in place instead, and only
    // when their content differs from the embedded copy.
    private static readonly string RuntimeRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexUsageOverlay", "runtime");

    // Small scripts are compared by hash so every edit lands; the bundled Node runtime is compared
    // by size, because reading and hashing 80 MB on each start costs more than the copy it saves.
    private const long HashLimit = 4 * 1024 * 1024;

    private static int Main(string[] args)
    {
        try
        {
            var root = RuntimeRoot;
            Unpack(root);
            DiscardSupersededRuntimes(root);

            if (args.Contains("--self-test"))
            {
                var required = new[] { "main.mjs", "widget-overlay.mjs", "placement.mjs", "quota-estimator.mjs", "hook-client.mjs", "transcript-recovery.mjs" };
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

    private static void Unpack(string root)
    {
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
            using var content = assembly.GetManifestResourceStream(name)!;
            var destination = Path.Combine(root, relative);
            if (IsCurrent(content, destination)) continue;
            Replace(content, destination);
        }
    }

    private static bool IsCurrent(Stream content, string destination)
    {
        var file = new FileInfo(destination);
        if (!file.Exists || file.Length != content.Length) return false;
        if (content.Length > HashLimit) return true;
        content.Position = 0;
        using var hash = SHA256.Create();
        var embedded = hash.ComputeHash(content);
        using var existing = File.OpenRead(destination);
        return embedded.AsSpan().SequenceEqual(hash.ComputeHash(existing));
    }

    private static void Replace(Stream content, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = destination + "." + Environment.ProcessId + ".tmp";
        content.Position = 0;
        using (var output = File.Create(temporary)) content.CopyTo(output);
        try
        {
            File.Move(temporary, destination, overwrite: true);
        }
        catch (IOException)
        {
            // A widget that is already running keeps node.exe open; it uses its copy until it exits,
            // and the next start picks up the new one.
            File.Delete(temporary);
        }
    }

    // Builds before this one unpacked into a directory named after their executable hash. Once the
    // hook command points at the stable path nothing refers to those copies, so they only waste
    // around 80 MB each. The node.exe check keeps this from touching anything else under runtime.
    private static void DiscardSupersededRuntimes(string root)
    {
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            var name = Path.GetFileName(directory);
            if (name.Length != 12 || !name.All(Uri.IsHexDigit)) continue;
            if (!File.Exists(Path.Combine(directory, "node.exe"))) continue;
            try
            {
                Directory.Delete(directory, true);
            }
            catch (Exception error)
            {
                Note($"Kept the superseded runtime {directory}: {error.Message}");
            }
        }
    }

    private static void Note(string message)
    {
        try
        {
            var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexUsageOverlay", "launcher.log");
            File.AppendAllText(path, $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}");
        }
        catch { /* The launcher has no usable log directory. */ }
    }
}
