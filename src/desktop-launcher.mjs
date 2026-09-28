import { spawnSync } from "node:child_process";

const PACKAGE_NAME = "OpenAI.Codex";

// ChatGPT ships as an MSIX package, so its executable cannot be started with CreateProcess:
// the resulting process has no package identity and the app aborts on startup. It has to be
// activated through the application activation manager, which also forwards the command line
// that opens the loopback debugging port.
const ACTIVATION_INTEROP = `
using System;
using System.Runtime.InteropServices;

public enum ActivateOptions { None = 0, DesignMode = 1, NoErrorUI = 2, NoSplashScreen = 4 }

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager
{
    [PreserveSig] int ActivateApplication([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [In, MarshalAs(UnmanagedType.LPWStr)] string arguments, [In] ActivateOptions options,
        [Out] out uint processId);
    [PreserveSig] int ActivateForFile([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [In] IntPtr itemArray, [In, MarshalAs(UnmanagedType.LPWStr)] string verb, [Out] out uint processId);
    [PreserveSig] int ActivateForProtocol([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [In] IntPtr itemArray, [Out] out uint processId);
}

public static class AppActivation
{
    public static uint Activate(string aumid, string arguments)
    {
        var type = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"), true);
        var manager = (IApplicationActivationManager)System.Activator.CreateInstance(type);
        uint processId;
        int result = manager.ActivateApplication(aumid, arguments, ActivateOptions.None, out processId);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        return processId;
    }
}
`;

const DISCOVERY_SCRIPT = `
$package = Get-AppxPackage -Name ${PACKAGE_NAME} | Select-Object -First 1
if (-not $package) { throw 'The ${PACKAGE_NAME} package is not installed for this user' }
$applications = @((Get-AppxPackageManifest -Package $package).Package.Applications.Application | Select-Object Id, Executable)
ConvertTo-Json -Compress -InputObject @{ packageFamilyName = $package.PackageFamilyName; applications = $applications }
`;

export function selectApplicationId(applications) {
  const entries = [applications].flat().filter((entry) => entry?.Id);
  const chatGpt = entries.find((entry) => /chatgpt\.exe$/i.test(entry.Executable ?? ""));
  const selected = chatGpt ?? entries[0];
  if (!selected) throw new Error(`The ${PACKAGE_NAME} package exposes no launchable application`);
  return selected.Id;
}

export function appUserModelId(manifest) {
  return `${manifest.packageFamilyName}!${selectApplicationId(manifest.applications)}`;
}

export function activationArguments(debugPort) {
  if (debugPort == null) return "";
  return `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`;
}

function runPowerShell(body) {
  const script = `$ErrorActionPreference = 'Stop'\ntry {\n${body}\n} catch { Write-Output ('ERROR: ' + $_.Exception.Message); exit 1 }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  const lines = (result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const error = lines.find((line) => line.startsWith("ERROR: "));
  if (error) throw new Error(error.slice("ERROR: ".length));
  if (result.status !== 0) throw new Error((result.stderr || "").trim() || "PowerShell could not be run");
  return lines.join("\n");
}

let cachedAumid = null;

export function findChatGptAumid() {
  if (!cachedAumid) cachedAumid = appUserModelId(JSON.parse(runPowerShell(DISCOVERY_SCRIPT)));
  return cachedAumid;
}

export function isChatGptRunning() {
  const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq ChatGPT.exe", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return /ChatGPT\.exe/i.test(result.stdout || "");
}

export function launchChatGpt(debugPort = null) {
  const aumid = findChatGptAumid();
  const commandLine = activationArguments(debugPort);
  const interop = `Add-Type -TypeDefinition @'\n${ACTIVATION_INTEROP}\n'@`;
  runPowerShell(`${interop}\n[AppActivation]::Activate('${aumid}', '${commandLine}') | Out-Null`);
}
