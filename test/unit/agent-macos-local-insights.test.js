'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const core = read('apps/agent-macos/Sources/EgressViewAgentCore/AgentLocalInsights.swift');
const model = read('apps/agent-macos/Xcode/Host/AgentMainViewModel.swift');
const window = read('apps/agent-macos/Xcode/Host/ObservationWindowController.swift');
const panel = read('apps/agent-macos/Xcode/Host/AgentInsightPanel.swift');

describe('macOS Agent local insights Phase 1', () => {
  it('adds a dedicated insights view without replacing network status', () => {
    assert.match(window, /case insights/);
    assert.match(window, /case \.insights: return L\("Insights"\)/);
    assert.match(window, /case \.insights: insightsView/);
    assert.match(window, /case \.network: analysisView/);
  });

  it('queries current and previous aggregates only while insights are visible', () => {
    const branch = model.slice(model.indexOf('if tab == .insights'));
    assert.match(branch, /appDestinationTotals\([\s\S]*grouping: \.name/);
    assert.match(branch, /previousStart = from\.addingTimeInterval\(-duration\)/);
    assert.match(branch, /AgentLocalInsightBuilder\.build/);
    assert.doesNotMatch(branch.slice(0, branch.indexOf('if tab == .log')), /observations\(since:/);
  });

  it('bounds the preview and gives it a schema independent of raw observations', () => {
    assert.match(core, /public static let itemLimit = 10/);
    assert.match(core, /public static let nameCharacterLimit = 255/);
    assert.match(core, /\.prefix\(itemLimit\)/);
    assert.match(core, /\.prefix\(nameCharacterLimit\)/);
    const context = core.slice(
      core.indexOf('public struct AgentLocalInsightContext'),
      core.indexOf('public struct AgentLocalInsightSnapshot')
    );
    assert.doesNotMatch(context, /ConnectionObservation|remoteAddress|processID|credential|memo/);
    assert.match(context, /topApplications/);
    assert.match(context, /topDestinations/);
  });

  it('keeps the bounded context builder independent of every provider', () => {
    assert.doesNotMatch(core, /URLSession|Anthropic|OpenAI|Bedrock|Ollama|InvokeModel/);
    assert.match(panel, /AI off · Insight data not sent/);
  });

  it('puts the model beside the readiness badge, with no card repeating it', () => {
    // The header badge already names the provider and says whether it is
    // ready. A separate card restating that was two controls saying one thing.
    assert.match(panel, /ForEach\(AgentAIProvider\.allCases\)/);
    assert.match(panel, /Picker\(L\("Provider"\)/);
    assert.match(panel, /Picker\(L\("Model"\)/);
    assert.doesNotMatch(panel, /private var modelBar/);
    const header = panel.slice(panel.indexOf('private var header'), panel.indexOf('private var modelPickers'));
    assert.match(header, /Ollama ready · Local only/);
    assert.ok(
      header.indexOf('Ollama ready · Local only') < header.indexOf('modelPickers'),
      'the model picker belongs under the badge that says whether it can answer'
    );
    const conversation = panel.slice(panel.indexOf('private func conversation'));
    assert.ok(
      conversation.indexOf('TextField(') < conversation.indexOf('activeMessages.isEmpty'),
      'the box you type in must come before the answers it produces'
    );
  });

  it('requires two explicit cloud consent steps and keeps the API key in Keychain', () => {
    const controller = read('apps/agent-macos/Xcode/Host/AgentOllamaController.swift');
    const settings = read('apps/agent-macos/Xcode/Host/HubDeliveryController.swift');
    const keyStore = read('apps/agent-macos/Sources/EgressViewAgentCore/AgentAPIKeyStore.swift');
    assert.match(settings, /Toggle\(isOn: \$openAICloudConsent\)/);
    assert.match(settings, /SecureField\(/);
    assert.match(panel, /Send bounded network metadata to OpenAI\?/);
    assert.match(panel, /pendingCloudQuestion/);
    assert.match(controller, /KeychainAgentAPIKeyStore/);
    assert.match(keyStore, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
    assert.doesNotMatch(controller, /defaults\.set\([^\n]*APIKey/);
  });

  it('offers deletion per message and for everything, and asks first', () => {
    assert.match(panel, /Button\(L\("Delete"\)\) \{ ollama\.deleteMessage\(message\.id\) \}/);
    assert.match(panel, /\.confirmationDialog\(/);
    assert.match(panel, /L\("Delete every AI conversation on this Mac\?"\)/);
    assert.match(panel, /Button\(L\("Delete all"\), role: \.destructive\) \{ ollama\.deleteAllHistory\(\) \}/);
  });

  it('records deletion as a flag and only ever appends', () => {
    const store = read('apps/agent-macos/Sources/EgressViewAgentCore/AgentAIConversationStore.swift');
    assert.match(store, /public func delete\(ids: Set<UUID>\)/);
    assert.match(store, /public func deleteAll\(\)/);
    assert.match(store, /struct AgentAIConversationDeletion/);
    assert.match(store, /clearsAllBefore/);
    // Nothing already written is rewritten: no replacement file, no truncate.
    // Matched against code with comments stripped -- a sentence explaining
    // this must not be what satisfies it.
    const storeCode = store.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(storeCode, /replaceItemAt|truncate/);
    assert.match(store, /private func applyDeletions/);
  });

  it('measures the history size against the file, not a cached number', () => {
    // URL.resourceValues caches: once a size was read for the store's URL it
    // returned that number however far the file had grown, so the 20 MB
    // fail-closed limit only held until the first append after launch.
    const store = read('apps/agent-macos/Sources/EgressViewAgentCore/AgentAIConversationStore.swift');
    const storeCode = store.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(storeCode, /resourceValues\(forKeys: \[\.fileSizeKey\]\)/);
    assert.match(storeCode, /FileManager\.default\.attributesOfItem\(atPath: fileURL\.path\)/);
  });

  it('does not tell the person the text left the disk', () => {
    // The rows stay in the file behind a flag. The wording says what actually
    // happened -- it no longer appears -- rather than claiming the bytes are
    // gone, which is what observation history (P3-43) promises and this does
    // not.
    const controller = read('apps/agent-macos/Xcode/Host/AgentOllamaController.swift');
    assert.doesNotMatch(controller, /gone from this Mac|removed from the history file/);
    assert.match(controller, /Deleted\. It no longer appears in this conversation\./);
    assert.doesNotMatch(panel, /removed from the history file/);
  });

  it('keeps the send preview on the insights tab', () => {
    // The person can read exactly what a manual question would carry, on the
    // same screen where they ask it.
    assert.match(panel, /AI context preview/);
    assert.match(panel, /Period: %@ – %@/);
    assert.match(panel, /Fields: current and previous totals/);
    assert.match(panel, /snapshot\.previewSizeBytes/);
    assert.match(panel, /Fields never included: raw connection rows, credentials, device notes/);
    assert.match(panel, /copyPreview/);
    assert.match(core, /public static let itemLimit = 10/);
  });
});
