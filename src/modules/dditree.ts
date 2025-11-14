import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
export type DDIBundle = { tree: JsonValue; elements: JsonValue };

type Meta = {
    signature: string;
    createdAt: string;
};

function cacheDir() {
    // Bump cache version to ensure new bundle format (tree + elements)
    return path.join(app.getPath('userData'), 'ddiTreeCache', 'v2');
}

function treePath() {
    return path.join(cacheDir(), 'tree.json');
}

function metaPath() {
    return path.join(cacheDir(), 'meta.json');
}

function elementsPath() {
    return path.join(cacheDir(), 'elements.json');
}

export function computeSignature(): string {
    const hash = crypto.createHash('sha256');
    try {
        hash.update(String(app.getVersion?.() ?? '0'));
    } catch {}

    // Rebuild tree only when the DDI codebook builder changes
    try {
        const libraryDir = path.join(__dirname, '../src/library/R');
        const pkgData = fs.readFileSync(path.join(libraryDir, 'library.data.gz'));
        hash.update(pkgData);
        const pkgMeta = fs.readFileSync(path.join(libraryDir, 'library.js.metadata'));
        hash.update(pkgMeta);
    } catch {}

    return hash.digest('hex');
}

function loadFromCache(expectedSig: string): JsonValue | DDIBundle | null {
    try {
        const metaRaw = fs.readFileSync(metaPath(), 'utf8');
        const meta = JSON.parse(metaRaw) as Meta;
        if (meta.signature !== expectedSig) return null;
        const raw = fs.readFileSync(treePath(), 'utf8');
        const parsed = JSON.parse(raw) as JsonValue;
        // If elements.json exists, return a bundle
        try {
            const eraw = fs.readFileSync(elementsPath(), 'utf8');
            const elements = JSON.parse(eraw) as JsonValue;
            try { console.log(`[DDITreeCache] Loaded cached tree+elements from: ${cacheDir()}`); } catch {}
            return { tree: parsed, elements } as DDIBundle;
        } catch {
            // no elements file – return only tree for backward compatibility
        }
        try { console.log(`[DDITreeCache] Loaded cached tree from: ${treePath()}`); } catch {}
        return parsed;
    } catch {
        return null;
    }
}

function saveToCache(sig: string, payload: JsonValue | DDIBundle) {
    try {
        fs.mkdirSync(cacheDir(), { recursive: true });
        if (isBundle(payload)) {
            fs.writeFileSync(treePath(), JSON.stringify((payload as DDIBundle).tree), 'utf8');
            fs.writeFileSync(elementsPath(), JSON.stringify((payload as DDIBundle).elements), 'utf8');
        } else {
            fs.writeFileSync(treePath(), JSON.stringify(payload as JsonValue), 'utf8');
            // Best-effort: if an old elements.json exists, leave it as-is
        }
        const meta: Meta = { signature: sig, createdAt: new Date().toISOString() };
        fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2), 'utf8');
        try {
            if (isBundle(payload)) {
                console.log(`[DDITreeCache] Saved tree to: ${treePath()}`);
                console.log(`[DDITreeCache] Saved elements to: ${elementsPath()}`);
            } else {
                console.log(`[DDITreeCache] Saved tree to: ${treePath()}`);
            }
            console.log(`[DDITreeCache] Wrote metadata to: ${metaPath()}`);
        } catch {}
    } catch {
        // best-effort: ignore write failures
    }
}

function isBundle(v: unknown): v is DDIBundle {
    return !!v && typeof v === 'object' && 'tree' in (v as any) && 'elements' in (v as any);
}

export async function getOrBuildDDITree(buildFn: () => Promise<JsonValue | DDIBundle>): Promise<JsonValue | DDIBundle> {
    const sig = computeSignature();
    const cached = loadFromCache(sig);
    if (cached) return cached;
    const fresh = await buildFn();
    saveToCache(sig, fresh);
    return fresh;
}
