// Test-only runtime stub for `obsidian` (the real npm package is types-only;
// esbuild externalizes it in the real build). This alias replaces `obsidian` for
// the ENTIRE vitest suite (see vitest.config.mts), so any value a test
// transitively imports must be provided here. Add new runtime exports as code
// under test reaches for them — a missing export surfaces as `undefined` at use
// (e.g. `instanceof TFile` throwing), not a clear error.
//
// Platform's device-class flags drive platform.ts's compute-backend allowlist.
// Tests mutate these to pose as different devices; the object is shared (one
// module instance).
export const Platform = {
    isMobile: false,
    isIosApp: false,
    isAndroidApp: false,
    isTablet: false,
    isPhone: false,
    isMacOS: false,
    isDesktop: true,
};

export const Keymap = {
    isModEvent(_evt?: MouseEvent | KeyboardEvent): false | 'tab' | 'split' | 'window' {
        return false;
    },
};

// Minimal runtime stubs for the values search.ts / main.ts read at module load
// or use with `instanceof`. Kept intentionally thin — extend as needed.
export class TFile {
    path = '';
    stat = { mtime: 0, ctime: 0, size: 0 };
    // Real Obsidian TFiles carry the lowercased extension; the index path reads
    // it (search.ts filters `.base` views via `f.extension === 'base'`). Default
    // '' so existing tests that only set path/stat are unaffected.
    extension = '';
}

// Minimal DOM node so IndexStatusBar / status-card tests can build UI without jsdom.
interface StubEl {
    tagName: string;
    className: string;
    textContent: string;
    style: { width: string };
    max: number;
    value: number;
    children: StubEl[];
    empty(): void;
    createDiv(opts?: { cls?: string; text?: string }): StubEl;
    createSpan(opts?: { cls?: string; text?: string }): StubEl;
    createEl(tag: string, opts?: { cls?: string; text?: string }): StubEl;
    addClass(cls: string): void;
    removeClass(cls: string): void;
    setText(text: string): void;
    setAttr(key: string, value: string): void;
    addEventListener(_type: string, _fn: unknown): void;
    querySelector(sel: string): StubEl | null;
}

function stubEl(tagName = 'div'): StubEl {
    const el: StubEl = {
        tagName,
        className: '',
        textContent: '',
        style: { width: '' },
        max: 1,
        value: 0,
        children: [],
        empty() { el.children = []; el.textContent = ''; },
        createDiv(opts) { return el.createEl('div', opts); },
        createSpan(opts) { return el.createEl('span', opts); },
        createEl(tag, opts) {
            const child = stubEl(tag);
            if (opts?.cls) child.className = opts.cls;
            if (opts?.text) child.textContent = opts.text;
            el.children.push(child);
            return child;
        },
        addClass(cls) { el.className = el.className ? `${el.className} ${cls}` : cls; },
        removeClass(cls) {
            el.className = el.className.split(/\s+/).filter(c => c && c !== cls).join(' ');
        },
        setText(text) { el.textContent = text; },
        setAttr(_key, _value) { /* tests don't assert attributes */ },
        addEventListener(_type, _fn) { /* no-op */ },
        querySelector(sel) {
            const walk = (n: StubEl): StubEl | null => {
                if (sel.startsWith('.')) {
                    if (n.className.split(/\s+/).includes(sel.slice(1))) return n;
                } else if (n.tagName === sel) {
                    return n;
                }
                for (const c of n.children) {
                    const hit = walk(c);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(el);
        },
    };
    return el;
}

export class Notice {
    messageEl: StubEl;
    noticeEl: StubEl;
    timeout: number | undefined;
    hidden = false;
    constructor(message?: string | DocumentFragment, timeout?: number) {
        this.timeout = timeout;
        this.messageEl = stubEl();
        this.noticeEl = this.messageEl;
        if (typeof message === 'string' && message) this.messageEl.textContent = message;
    }
    setMessage(message: string): this {
        this.messageEl.setText(message);
        return this;
    }
    hide(): void { this.hidden = true; }
}
export function setIcon(_el: HTMLElement, _iconId: string): void {}
export function setTooltip(_el: HTMLElement, _tooltip: string, _options?: unknown): void {}

// Class stubs for the values search-modal.ts binds at MODULE LOAD (`class
// SeekSearchModal extends Modal`), so importing that module for a unit test of
// one of its pure exports (titleNavCoverage) doesn't die on `extends undefined`.
// Bodies stay empty on purpose: nothing here is exercised, and a stub with
// behaviour would invite tests that assert against the stub instead of Obsidian.
export class Component {
    onload(): void {}
    onunload(): void {}
}
export class Modal extends Component {
    constructor(_app?: unknown) {
        super();
    }
    open(): void {}
    close(): void {}
}
export class MarkdownView extends Component {}
export const MarkdownRenderer = {
    render: async (): Promise<void> => {},
};

export class App {
    vault: Record<string, unknown> = {};
    workspace: Record<string, unknown> = {};
    metadataCache: Record<string, unknown> = {};
    fileManager: Record<string, unknown> = {};
    appId = 'test-vault';
}

export class Plugin extends Component {
    app: App;
    manifest: Record<string, unknown>;
    constructor(app?: App, manifest?: Record<string, unknown>) {
        super();
        this.app = app ?? new App();
        this.manifest = manifest ?? { id: 'seek', name: 'Seek', version: '1.4.0' };
    }
    async loadData(): Promise<unknown> { return {}; }
    async saveData(_data: unknown): Promise<void> {}
    addCommand(_cmd: unknown): unknown { return _cmd; }
    addSettingTab(_tab: unknown): void {}
    registerObsidianProtocolHandler(_action: string, _handler: unknown): void {}
    registerEvent(_eventRef: unknown): void {}
    registerDomEvent(_el: unknown, _type: string, _callback: unknown): void {}
    registerInterval(id: number): number { return id; }
    addStatusBarItem(): HTMLElement { return stubEl() as unknown as HTMLElement; }
}

export class PluginSettingTab {
    app: App;
    plugin: Plugin;
    containerEl: StubEl;
    constructor(app?: App, plugin?: Plugin) {
        this.app = app ?? new App();
        this.plugin = plugin ?? ({} as Plugin);
        this.containerEl = stubEl();
    }
    display(): void {}
    hide(): void {}
}

export class Setting {
    settingEl: StubEl;
    nameEl: StubEl;
    descEl: StubEl;
    controlEl: StubEl;
    constructor(_containerEl?: unknown) {
        this.settingEl = stubEl();
        this.nameEl = stubEl();
        this.descEl = stubEl();
        this.controlEl = stubEl();
    }
    setName(_name: string): this { return this; }
    setDesc(_desc: unknown): this { return this; }
    addText(_cb: (text: unknown) => void): this { return this; }
    addToggle(_cb: (toggle: unknown) => void): this { return this; }
    addSlider(_cb: (slider: unknown) => void): this { return this; }
    addDropdown(_cb: (dropdown: unknown) => void): this { return this; }
    addButton(_cb: (button: unknown) => void): this { return this; }
    setClass(_cls: string): this { return this; }
    setDisabled(_disabled: boolean): this { return this; }
}

// Obsidian's real `parseYaml` is a thin wrapper over a YAML parser, so the
// dev-only `yaml` dependency is a faithful runtime stand-in for tests (base-
// extractor.ts is the only consumer). The real build uses Obsidian's export at
// zero bundle cost; `yaml` never ships. (`yaml.parse` returns `any`, so the
// result is widened to `unknown` to match Obsidian's typed signature.)
import { parse as parseYamlImpl } from 'yaml';
export function parseYaml(yaml: string): unknown {
    return parseYamlImpl(yaml) as unknown;
}
