import { continueRender, delayRender, registerRoot } from 'remotion';
import { Root } from './Root';
import { ensureLocaleDict } from '../src/i18n/locale';

const localeGate = delayRender('locale dictionary');
void ensureLocaleDict().finally(() => continueRender(localeGate));

registerRoot(Root);
