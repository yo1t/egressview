using System.Runtime.InteropServices;

namespace EgressView.Agent.Ui;

internal static class WindowsApplicationRestart
{
    // Allow Windows Installer / Restart Manager to restore the user's tray
    // process, but do not turn an app crash, hang, or OS reboot into a launch.
    private const int RestartNoCrash = 1;
    private const int RestartNoHang = 2;
    private const int RestartNoReboot = 8;

    internal static void RegisterForInstallerUpdate()
    {
        _ = RegisterApplicationRestart("--tray", RestartNoCrash | RestartNoHang | RestartNoReboot);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegisterApplicationRestart(string commandLine, int flags);
}
