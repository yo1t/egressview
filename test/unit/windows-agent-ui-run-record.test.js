'use strict';

// P3-102: the Windows window's run record says when it really stopped, and a
// second launch does not rewrite it.
//
// Two defects, both found by reading run_history on a real machine: 34 of 49
// window runs read "unexpected", and every one of them had died, on paper, the
// moment it started. The window reported its run before checking whether it
// was the window at all, so the installer's --exit-ui helper and every
// "open the window" launch settled the real window's run as a crash; and the
// window only ever wrote one heartbeat, its first.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src');
const app = fs.readFileSync(path.join(root, 'EgressView.Agent.Ui', 'App.xaml.cs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'EgressView.Agent.Service', 'AgentIpcServer.cs'), 'utf8');

describe('the Windows window run record', () => {
  it('opens a run only after knowing this process is the window', () => {
    const onStartup = app.slice(app.indexOf('protected override void OnStartup'));
    const mutex = onStartup.indexOf('instanceMutex = new Mutex(');
    const exitHelper = onStartup.indexOf('if (e.Args.Contains("--exit-ui"', mutex + 1);
    const begin = onStartup.indexOf('ReportRun("begin"');
    assert.ok(mutex > 0 && begin > 0, 'the single-instance check or the run report is missing');
    assert.ok(begin > mutex, 'the run is reported before the single-instance check');
    assert.ok(exitHelper > 0 && begin > exitHelper, 'the run is reported before the --exit-ui helper leaves');
  });

  it('reports nothing from a process that did not open the run', () => {
    const reportRun = app.slice(app.indexOf('private static void ReportRun('));
    const body = reportRun.slice(0, reportRun.indexOf('var request'));
    assert.match(body, /if \(!runOpened\) return;/, 'a second launch can end or fault the real window\'s run');
  });

  it('notes an orderly exit where the window can write, and hands it to the next start', () => {
    // An update stops the service two seconds before it closes the window, so
    // the window's "end" reaches nobody; the note carries it to the next start.
    const onExit = app.slice(app.indexOf('protected override void OnExit'));
    const note = onExit.indexOf('WriteExitNote()');
    assert.ok(note > 0 && note < onExit.indexOf('ReportRun("end")'), 'the exit is not noted before the end report');
    assert.match(app, /ReportRun\("begin", previousExit: TakeExitNote\(\)\)/, 'the next start does not pass the note on');
  });

  it('lets a window that outlived a service restart carry on its run', () => {
    // Killing the service on 0.1.156 recorded the still-running window as a
    // crash at its start, and the new service then recorded nothing it did.
    const start = server.slice(server.indexOf('public void Start()'));
    assert.match(start.slice(0, start.indexOf('\n    }')), /unclaimedUiRunId = store\.OpenWindowRun\(\)/,
      'a starting service does not look for the window run left open');
    const note = server.slice(server.indexOf('private void NoteUiAlive()'));
    assert.match(note.slice(0, note.indexOf('private void RecordUiRun')), /uiRunId = unclaimedUiRunId;/,
      'the window\'s requests do not reclaim its run');
    const store = fs.readFileSync(path.join(root, 'EgressView.Agent.Core', 'ObservationStore.cs'), 'utf8');
    const beginRun = store.slice(store.indexOf('public long BeginRun('), store.indexOf('/// Files the service starts'));
    assert.doesNotMatch(beginRun, /component='ui' AND ending='running' AND started_at/,
      'a service start still settles the window run on the spot');
  });

  it('keeps the window\'s run alive from its requests, off the answering path', () => {
    const serve = server.slice(server.indexOf('private async Task ServeOneAsync('));
    const alive = serve.indexOf('NoteUiAlive();');
    const answer = serve.indexOf('Task.Run(() => Handle(line)');
    assert.ok(alive > 0 && alive < answer, 'requests from the window do not refresh its run');
    const note = server.slice(server.indexOf('private void NoteUiAlive()'));
    assert.match(note.slice(0, note.indexOf('private void RecordUiRun')), /Task\.Run\(\(\) =>[\s\S]*store\.Heartbeat\(run\)/,
      'the heartbeat is written on the answering path');
  });
});
