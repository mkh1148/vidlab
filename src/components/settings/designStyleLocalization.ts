// Design-style display names, roles and style guides used to have a Chinese table each,
// consulted only when the interface language was Chinese. There is one interface language
// (owner decision D-11), so the tables are gone and these four helpers return the source
// string unchanged.
//
// The signatures keep the `locale` slot because the settings panel threads one locale
// through its section components; the argument is inert, exactly like the Chinese slot on
// localizedCatalogText. Deleting the helpers outright would mean removing that prop from
// five components for no behavioural gain.
import type { Locale } from '../../i18n/locale';

export function localizeDesignPresetName(name: string, _locale: Locale): string {
  return name;
}

export function localizeDesignRole(role: string, _locale: Locale): string {
  return role;
}

export function localizeDesignFontRole(role: string, _locale: Locale): string {
  return role;
}

export function localizeDesignStyleGuide(guide: string, _locale: Locale): string {
  return guide;
}
