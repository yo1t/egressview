'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const client = read('apps/agent-macos/Sources/EgressViewAgentCore/AgentOllamaClient.swift');
const history = read('apps/agent-macos/Sources/EgressViewAgentCore/AgentAIConversationStore.swift');
const controller = read('apps/agent-macos/Xcode/Host/AgentOllamaController.swift');
const panel = read('apps/agent-macos/Xcode/Host/AgentInsightPanel.swift');
const settings = read('apps/agent-macos/Xcode/Host/HubDeliveryController.swift');
const appDelegate = read('apps/agent-macos/Xcode/Host/AgentAppDelegate.swift');
const mainModel = read('apps/agent-macos/Xcode/Host/AgentMainViewModel.swift');

describe('macOS Agent Ollama Phase 2 safety boundary', () => {
  it('accepts only HTTP loopback and disables proxies and redirects', () => {
    assert.match(client, /url\.scheme == "http"/);
    assert.match(client, /host == "::1" \|\| host == "127\.0\.0\.1" \|\| host\.hasPrefix\("127\."\)/);
    assert.match(client, /connectionProxyDictionary = \[:\]/);
    assert.match(client, /AgentNoRedirectDelegate/);
    assert.match(client, /timeout: TimeInterval = 30/);
  });

  it('bounds context, response, history, and conversation depth', () => {
    assert.match(client, /maximumResponseBytes = 1_048_576/);
    assert.match(client, /for try await byte in bytes/);
    assert.match(client, /guard data\.count < maximumResponseBytes/);
    assert.match(client, /maximumContextBytes = 65_536/);
    assert.match(client, /history\.suffix\(20\)/);
    assert.match(history, /maximumFileBytes = 20 \* 1_048_576/);
    assert.match(history, /posixPermissions: 0o600/);
    assert.match(client, /think: false/);
    assert.match(client, /ChatOptions\(numPredict: 384\)/);
    assert.match(client, /at most four short bullets and 500 characters total/);
  });

  it('runs only from explicit UI actions, one request at a time, with stop', () => {
    assert.match(panel, /Button\(L\("Analyze current period"\)\)/);
    assert.match(panel, /Button\(L\("Ask"\)\)/);
    assert.match(panel, /Button\(L\("Stop"\)/);
    assert.match(controller, /guard isEnabled, !isRunning else \{ return \}/);
    assert.match(controller, /inferenceTask\?\.cancel\(\)/);
    assert.match(controller, /\(error as\? URLError\)\?\.code == \.cancelled/);
    assert.doesNotMatch(controller, /Timer|PeriodicWork|onAppear[\s\S]*analyze\(/);
  });

  it('keeps the endpoint in Settings > AI and shares one controller with Insights', () => {
    assert.match(settings, /case \.ai: aiSettings/);
    assert.match(settings, /ollama\.setEndpoint/);
    // Via selectModel, which sets it and re-tests in one action.
    assert.match(settings, /ollama\.selectModel/);
    assert.match(settings, /ollama\.saveAndTest\(\)/);
    // Changed 2026-08-28: the model moved back onto the insights screen, so a
    // person can see and switch which model is answering without leaving the
    // answers. The endpoint did not -- it is set once, and a wrong value there
    // is the difference between local and not local.
    assert.doesNotMatch(panel, /ollama\.setEndpoint/);
    assert.match(panel, /ollama\.selectCurrentModel/);
    assert.match(appDelegate, /private lazy var ollamaController = AgentOllamaController\(\)/);
    assert.match(appDelegate, /ObservationWindowController\(store: store, ollama: ollamaController\)/);
    assert.match(appDelegate, /ollama: ollamaController/);
    assert.match(mainModel, /init\(store: ObservationStore\?, ollama: AgentOllamaController\)/);
  });

  it('localizes live status from state instead of freezing the previous language', () => {
    assert.match(controller, /private enum StatusState/);
    assert.match(controller, /case \.ollama: statusState\.map\(localized\)/);
    assert.match(controller, /case \.anthropic: anthropicStatus/);
    assert.match(controller, /case \.openAI: openAIStatus/);
    assert.match(controller, /case \.connected\(let model\): return L\("Connected to Ollama/);
    assert.doesNotMatch(controller, /@Published private\(set\) var status: String\?/);
  });

  it('accepts Ollamas implicit latest tag without fuzzy model matching', () => {
    assert.match(client, /!requested\.contains\(":"\) && models\.contains\("\\\(requested\):latest"\)/);
    assert.match(controller, /AgentOllamaClient\.isModel\(configuration\.model, availableIn: models\)/);
  });

  it('persists result metadata append-only and restores it', () => {
    assert.match(history, /try handle\.seekToEnd\(\)/);
    assert.match(history, /try handle\.write\(contentsOf: line\)/);
    for (const field of ['conversationID', 'requestID', 'provider', 'model', 'status', 'inputTokens', 'outputTokens']) {
      assert.match(history, new RegExp(`let ${field}`));
    }
    assert.match(controller, /status: \.failed/);
    assert.match(controller, /restoreHistory\(\)/);
    assert.match(controller, /completedRequests\.contains\(\$0\.requestID\)/);
    assert.match(controller, /activeConversationID = nil/);
  });

  it('lists installed models so the person can pick one', () => {
    // api/tags answers "what is installed" and never uses the model name.
    // Requiring one meant nobody could discover the models until they had
    // already typed one correctly.
    assert.match(client, /public static func validatedEndpoint/);
    assert.match(client, /public func availableModels\(endpoint url: URL\)/);
    assert.match(controller, /catch AgentOllamaError\.invalidModel \{[\s\S]*listModelsForChoosing\(\)/);
    // Listing enables nothing on its own: a model still has to be chosen and
    // confirmed before analysis is allowed.
    const listing = controller.slice(
      controller.indexOf('private func listModelsForChoosing'),
      controller.indexOf('/// Ask Ollama which models it has')
    );
    assert.match(listing, /setEnabled\(false\)/);
    assert.doesNotMatch(listing, /setEnabled\(true\)/);
  });

  it('never reaches for Ollama on a Mac where it was not set up', () => {
    // The endpoint defaults to loopback whether or not Ollama exists, so
    // probing on screen appearance would probe every Mac. The automatic
    // refresh runs only once the person has enabled it.
    const refresh = controller.slice(controller.indexOf('func refreshAvailableModels'));
    assert.match(refresh.slice(0, 200), /guard isEnabled/);
    assert.match(panel, /\.task\(id: ollama\.isEnabled\) \{ ollama\.refreshAvailableModels\(\) \}/);
  });

  it('keeps a question above its own answer while showing the newest first', () => {
    // Reversing every message put each answer above the question that
    // produced it. Exchanges are reversed; the messages inside one are not.
    assert.match(panel, /private var exchanges: \[Exchange\]/);
    assert.match(panel, /grouped\[message\.requestID, default: \[\]\]\.append\(message\)/);
    assert.match(panel, /order\.reversed\(\)\.map/);
    assert.doesNotMatch(panel, /activeMessages\.reversed\(\)/);
  });

  it('offers the model as a list in Settings too, from one definition', () => {
    assert.match(settings, /Picker\(L\("Model"\), selection: Binding\(/);
    assert.doesNotMatch(settings, /TextField\(L\("Example: qwen3:8b"\)/);
    // Both screens read the same list, so they cannot disagree about which
    // models exist.
    assert.match(controller, /var modelChoices: \[String\]/);
    assert.match(settings, /ollama\.modelChoices/);
    assert.match(panel, /ollama\.currentModelChoices/);
  });

  it('reconnects when a model is picked, and only announces failures', () => {
    // Picking from a list is one deliberate action. Leaving AI switched off
    // afterwards with "you changed something, check again" reported the
    // person's own choice back to them as a problem.
    assert.match(controller, /func selectModel\(_ name: String\)/);
    const select = controller.slice(controller.indexOf('func selectModel'));
    assert.match(select.slice(0, 400), /setModel\(name\)[\s\S]*saveAndTest\(\)/);
    assert.match(panel, /set: \{ ollama\.selectCurrentModel\(\$0\) \}/);
    assert.match(settings, /set: \{ ollama\.selectModel\(\$0\) \}/);

    // An endpoint is typed a character at a time and must not connect on every
    // keystroke, so it keeps the explicit button.
    assert.match(settings, /set: \{ ollama\.setEndpoint\(\$0\) \}/);
    assert.match(settings, /ollama\.saveAndTest\(\)/);

    // The insights screen shows a problem, not a success announcement.
    assert.match(controller, /var problem: String\? \{/);
    assert.match(panel, /if let problem = ollama\.problem/);
    assert.doesNotMatch(panel, /ollama\.status/);
    assert.match(settings, /ollama\.status/);
  });

  it('keeps the Ollama client free of cloud providers and credentials', () => {
    assert.doesNotMatch(client, /Anthropic|OpenAI|Bedrock|InvokeModel|apiKey|Keychain/);
  });
});
