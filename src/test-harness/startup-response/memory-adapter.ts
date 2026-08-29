import type { DataAdapter, Stat } from 'obsidian';

/**
 * In-memory implementation of the DataAdapter surface used by the sidecar.
 * It keeps startup-response fixtures independent from a real vault and disk.
 */
export class MemoryDataAdapter {
    readonly text = new Map<string, string>();
    readonly binary = new Map<string, ArrayBuffer>();

    async exists(path: string): Promise<boolean> {
        if (this.text.has(path) || this.binary.has(path)) return true;
        const prefix = path.endsWith('/') ? path : `${path}/`;
        return [...this.text.keys(), ...this.binary.keys()].some(key => key.startsWith(prefix));
    }

    async mkdir(_path: string): Promise<void> {}

    async read(path: string): Promise<string> {
        const value = this.text.get(path);
        if (value === undefined) throw new Error(`ENOENT ${path}`);
        return value;
    }

    async write(path: string, data: string): Promise<void> {
        this.text.set(path, data);
    }

    async append(path: string, data: string): Promise<void> {
        this.text.set(path, (this.text.get(path) ?? '') + data);
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const value = this.binary.get(path);
        if (value === undefined) throw new Error(`ENOENT ${path}`);
        return value.slice(0);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        this.binary.set(path, data.slice(0));
    }

    async rename(from: string, to: string): Promise<void> {
        if (this.binary.has(from)) {
            this.binary.set(to, this.binary.get(from)!);
            this.binary.delete(from);
            return;
        }
        if (this.text.has(from)) {
            this.text.set(to, this.text.get(from)!);
            this.text.delete(from);
            return;
        }
        throw new Error(`ENOENT ${from}`);
    }

    async remove(path: string): Promise<void> {
        this.text.delete(path);
        this.binary.delete(path);
    }

    async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders = new Set<string>();
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        for (const path of [...this.text.keys(), ...this.binary.keys()]) {
            if (!path.startsWith(prefix)) continue;
            const rest = path.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash < 0) files.push(path);
            else folders.add(prefix + rest.slice(0, slash));
        }
        return { files, folders: [...folders] };
    }

    async stat(path: string): Promise<Stat | null> {
        const binary = this.binary.get(path);
        if (binary) {
            return { type: 'file', size: binary.byteLength, ctime: 0, mtime: 0 };
        }
        const text = this.text.get(path);
        if (text !== undefined) {
            return { type: 'file', size: text.length, ctime: 0, mtime: 0 };
        }
        return null;
    }

    asDataAdapter(): DataAdapter {
        return this as unknown as DataAdapter;
    }
}
