# Language Settings

## Purpose

Select the interface language. This controls the wording of all labels, buttons, messages and reports in the application.

## Features

- **Two supported languages**: English (`en`) and Vietnamese (`vi`)
- **Left-to-right only**: both languages are written LTR, so there is no text-direction control
- **Instant application**: the change takes effect without a page reload
- **Per device**: the choice is stored in browser storage (`app-page` key), not in the database

## User Workflow

1. Open Settings (`/settings`)
2. Find the **Language** card
3. Click **English** or **Tiếng Việt**
4. The interface re-renders in the chosen language and that button stays highlighted

## Business Rules

- **Default language**: `en`, unless `VITE_DEFAULT_LANGUAGE=vi` is set at build time (only `en` and `vi` are accepted; any other value falls back to `en`)
- **Unknown stored value**: if a saved language is no longer supported, `isSupportedLanguage()` sends the app back to the default
- **Missing keys**: i18next falls back to English per key, so an untranslated key shows English text rather than the raw key path
- **Per device, not per user**: the preference is browser storage, so it resets when storage is cleared and does not follow the user to another terminal

## Fields

### Language Selection
- **Purpose**: choose the interface language
- **Type**: button selection (single choice)
- **Options**: English (`en`), Tiếng Việt (`vi`)
- **Default**: English
- **Behaviour**: applied immediately, no save button

## Edge Cases

- **Number and date format**: Luxon `Settings.defaultLocale` follows the selected language, so `vi` formats dates with Vietnamese locale data while currency and number policy stay under Settings → Number policy
- **Spoken "order ready" announcements**: use `vi-VN` for Vietnamese and `en-US` otherwise; a device without a Vietnamese voice falls back to `en-US`
- **AI assistant routing**: write-tool routing keywords cover English and Vietnamese only (see `src/lib/ai/tools/write-intent-i18n.ts`), so a prompt in another language is treated as read-only
- **User-generated content**: dish names, table labels and notes are stored as typed and are never translated

## Configuration

Language is held in the Jotai atom `appPage` (`src/store/jotai.ts`) and persisted by `atomWithStorage` under the browser key `app-page`. The supported list itself lives in `src/lib/languages.ts`; locale JSON lives in `src/locales/<code>/<namespace>.json` (22 namespaces).

## Known Limitations

- **No runtime language download**: adding a language means adding files and redeploying the build
- **No per-module language**: one language applies to the whole terminal
- **Customer self-order screen**: `src/self-order/` is English-only and is not wired to i18next
- **In-app user guide**: `docs/user-guide/locales/` currently ships English; Vietnamese requests fall back to English guide text

## Future Extension Points

- Persist the language choice per user account instead of per device
- Detect the browser language on first login and preselect `en` or `vi`
- Wire the self-order QR screen and the user guide into the same two-language catalogue
