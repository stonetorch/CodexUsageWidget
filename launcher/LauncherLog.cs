using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class LauncherLog
{
    public static TextWriter Open(string directory)
    {
        var primary = TryOpen(Path.Combine(directory, "launcher.log"));
        if (primary != null) return primary;

        // An older launcher or a log viewer may hold the primary file exclusively.
        // Each fallback belongs to this launch, so concurrent starts cannot collide.
        var name = "launcher-" + Process.GetCurrentProcess().Id + "-" + Guid.NewGuid().ToString("N") + ".log";
        var fallback = TryOpen(Path.Combine(directory, name));
        if (fallback != null)
        {
            fallback.WriteLine("Primary launcher.log unavailable; using " + name);
            return fallback;
        }

        // Logging must not prevent the runtime from starting or draining its output.
        return TextWriter.Null;
    }

    private static StreamWriter TryOpen(string path)
    {
        try
        {
            return new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false)) { AutoFlush = true };
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }
}
