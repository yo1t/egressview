'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const uiRoot = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src', 'EgressView.Agent.Ui');
const windowXaml = fs.readFileSync(path.join(uiRoot, 'MainWindow.xaml'), 'utf8');
const theme = fs.readFileSync(path.join(uiRoot, 'Themes', 'Fluent.xaml'), 'utf8');

// Three empty boxes in a row said nothing about what each one filtered; the
// only hint was a tooltip. Each now shows its column's name, faintly, until
// something is typed.
describe('Windows Agent log filter placeholders', () => {
  for (const [box, label] of [['AppFilter', 'Process'], ['DestinationFilter', 'Destination'], ['PortFilter', 'Port']]) {
    it(`${box} is labelled with its column's name while empty`, () => {
      assert.ok(windowXaml.includes(
        `<TextBlock Text="{DynamicResource ${label}}" Tag="{Binding ElementName=${box}}" Style="{StaticResource FilterPlaceholderStyle}"/>`));
    });
  }

  it('the label shows only while the box is empty and never takes a click', () => {
    const style = theme.slice(theme.indexOf('x:Key="FilterPlaceholderStyle"'), theme.indexOf('</Style>', theme.indexOf('x:Key="FilterPlaceholderStyle"')));
    assert.ok(style.includes('<Setter Property="Visibility" Value="Collapsed"/>'));
    assert.ok(style.includes('<DataTrigger Binding="{Binding Tag.Text, RelativeSource={RelativeSource Self}}" Value="">'));
    assert.ok(style.includes('<Setter Property="IsHitTestVisible" Value="False"/>'));
  });
});
