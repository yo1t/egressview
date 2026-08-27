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

  it('has no provider client or automatic send path', () => {
    const phaseOne = `${core}\n${model}\n${panel}`;
    assert.doesNotMatch(phaseOne, /URLSession|Anthropic|OpenAI|Bedrock|Ollama|InvokeModel/);
    assert.match(panel, /No AI · Insight data not sent/);
    assert.match(panel, /Phase 1 does not include an AI provider or a send action/);
  });

  it('shows the period, field counts, size and explicit exclusions before copying', () => {
    assert.match(panel, /Period: %@ – %@/);
    assert.match(panel, /Fields: current and previous totals/);
    assert.match(panel, /snapshot\.previewSizeBytes/);
    assert.match(panel, /Fields never included: raw connection rows, credentials, device notes/);
    assert.match(panel, /copyPreview/);
  });
});
