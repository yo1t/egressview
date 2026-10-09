using System.Security;

namespace EgressView.Agent.Core;

/// The Task Scheduler task that starts the window in the notification area
/// when its user signs in (P3-106).
///
/// It was a value under HKCU\...\Run. Measured on 2026-10-10: the service
/// answered 0.3 s after it started, before sign-in, and the window reached it
/// 0.4 s after the window started -- but Windows started the window 28.5 s
/// after sign-in, because Explorer holds back everything under Run for a
/// while after a user signs in. A logon task is started by Task Scheduler, not
/// Explorer, and is not held back.
public static class StartupTask
{
    public const string Name = "EgressView Agent UI";

    /// A task for one user, run as that user with no more than their own
    /// rights, at their sign-in only.
    ///
    /// The settings that differ from Task Scheduler's defaults are each there
    /// because the default would stop a resident window: tasks are stopped
    /// after 72 hours, are not started on battery, and run at below-normal
    /// priority.
    public static string Xml(string userSid, string executablePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(userSid);
        ArgumentException.ThrowIfNullOrWhiteSpace(executablePath);
        var user = SecurityElement.Escape(userSid);
        var command = SecurityElement.Escape(executablePath);
        return $"""
            <?xml version="1.0" encoding="UTF-16"?>
            <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
              <RegistrationInfo>
                <Description>Shows EgressView Agent in the notification area when you sign in.</Description>
              </RegistrationInfo>
              <Triggers>
                <LogonTrigger>
                  <Enabled>true</Enabled>
                  <UserId>{user}</UserId>
                </LogonTrigger>
              </Triggers>
              <Principals>
                <Principal id="Author">
                  <UserId>{user}</UserId>
                  <LogonType>InteractiveToken</LogonType>
                  <RunLevel>LeastPrivilege</RunLevel>
                </Principal>
              </Principals>
              <Settings>
                <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
                <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
                <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
                <AllowHardTerminate>false</AllowHardTerminate>
                <StartWhenAvailable>false</StartWhenAvailable>
                <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
                <IdleSettings>
                  <StopOnIdleEnd>false</StopOnIdleEnd>
                  <RestartOnIdle>false</RestartOnIdle>
                </IdleSettings>
                <AllowStartOnDemand>true</AllowStartOnDemand>
                <Enabled>true</Enabled>
                <Hidden>false</Hidden>
                <RunOnlyIfIdle>false</RunOnlyIfIdle>
                <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
                <Priority>5</Priority>
              </Settings>
              <Actions Context="Author">
                <Exec>
                  <Command>{command}</Command>
                  <Arguments>--tray</Arguments>
                </Exec>
              </Actions>
            </Task>
            """;
    }
}
