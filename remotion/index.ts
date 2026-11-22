import { continueRender, delayRender, registerRoot } from 'remotion';
import { Root } from './Root';
import { ensureLocaleDict, getLocale } from '../src/i18n/locale';

const localeGate = delayRender('locale dictionary');
void ensureLocaleDict(getLocale()).finally(() => continueRender(localeGate));

registerRoot(Root);
