// Design-style names, roles and guides render as the source data says (owner decision
// D-11). The Chinese display tables these helpers used to consult are gone with the other
// interface languages, so the guarantee is now the opposite one: nothing renames a preset,
// a colour role or a style guide on its way to the settings panel.
import assert from 'node:assert/strict';
import { DESIGN_STYLE_PRESETS } from '../../editor/design-presets';
import {
  localizeDesignFontRole,
  localizeDesignPresetName,
  localizeDesignRole,
  localizeDesignStyleGuide,
} from './designStyleLocalization';

const modern = DESIGN_STYLE_PRESETS.find((preset) => preset.name === 'Modern Editorial');
assert.ok(modern, 'the fixture must contain Modern Editorial');

assert.equal(localizeDesignPresetName(modern.name, 'en'), modern.name);
assert.equal(localizeDesignRole('background-chart', 'en'), 'background-chart');
assert.equal(localizeDesignFontRole('accent', 'en'), 'accent');
assert.equal(localizeDesignStyleGuide(modern.style.styleGuide ?? '', 'en'), modern.style.styleGuide);

// Every preset, not just the fixture: a table that came back for one name would show up
// as a renamed row in the settings panel.
for (const preset of DESIGN_STYLE_PRESETS) {
  assert.equal(
    localizeDesignPresetName(preset.name, 'en'),
    preset.name,
    `${preset.name} must display unchanged`,
  );
  assert.equal(
    localizeDesignStyleGuide(preset.style.styleGuide ?? '', 'en'),
    preset.style.styleGuide,
    `${preset.name} must keep its own style guide`,
  );
}

console.log('design-style-localization.verify: preset names, roles and guides display unchanged');
