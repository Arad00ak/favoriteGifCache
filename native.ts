/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, dialog } from "electron";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from "fs";
import { join, resolve, sep } from "path";

export type NativeCacheRecord = {
    key: string;
    data: ArrayBuffer;
    mimeType: string;
    useCount: number;
    lastUsed: number;
    createdAt: number;
    size: number;
};

const ALLOWED_MEDIA_HOSTS = [
    "media.tenor.com",
    "tenor.com",
    "c.tenor.com",
    "static.klipy.com",
    "media.klipy.com",
    "cdn.klipy.com",
    "gifs.klipy.com",
    "i.klipy.com",
    "media1.klipy.com",
    "media2.klipy.com",
    "c.klipy.com",
    "klipy.com",
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
    "i.giphy.com",
    "giphy.com",
    "media.discordapp.net",
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "discordapp.net",
    "discordapp.com",
    "discord.com",
] as const;

const DEFAULT_MAX_DOWNLOAD = 12 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function blobsDir(dir: string) {
    return join(dir, "blobs");
}

function metaPath(dir: string) {
    return join(dir, "meta.json");
}

function fileNameForKey(key: string) {
    return Buffer.from(key, "utf8").toString("base64url");
}

function isSafeBlobFileName(name: string) {
    return typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name);
}

function resolveBlobPath(dir: string, file: string): string | null {
    if (!isSafeBlobFileName(file)) return null;
    const root = resolve(blobsDir(dir));
    const full = resolve(join(root, file));
    if (full !== root && !full.startsWith(root + sep)) return null;
    return full;
}

function hostAllowed(hostname: string) {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    for (const allowed of ALLOWED_MEDIA_HOSTS) {
        if (h === allowed || h.endsWith("." + allowed)) return true;
    }
    return false;
}

function isAllowedMediaUrl(url: string): URL | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!hostAllowed(parsed.hostname)) return null;
    return parsed;
}

function readMeta(dir: string): Record<string, Omit<NativeCacheRecord, "data" | "key"> & { file: string; }> {
    const p = metaPath(dir);
    if (!existsSync(p)) return {};
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return {};
    }
}

function writeMeta(dir: string, meta: Record<string, unknown>) {
    writeFileSync(metaPath(dir), JSON.stringify(meta), "utf8");
}

export function getDefaultCacheDir() {
    return join(app.getPath("userData"), "FavoriteGifCache");
}

export async function fetchMedia(
    _e: unknown,
    url: string,
    maxBytes: number = DEFAULT_MAX_DOWNLOAD,
): Promise<{ data: ArrayBuffer; type: string; } | null> {
    if (!url || typeof url !== "string") return null;

    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(30_000)
        : undefined;
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const parsed = isAllowedMediaUrl(current);
        if (!parsed) return null;

        const res = await fetch(parsed.href, {
            headers: { Accept: "image/*,video/*,*/*;q=0.8" },
            redirect: "manual",
            credentials: "omit",
            signal,
        });

        if (res.status >= 300 && res.status < 400) {
            try { await res.body?.cancel(); } catch { }
            const loc = res.headers.get("location");
            if (!loc) return null;
            let next: URL;
            try {
                next = new URL(loc, parsed.href);
            } catch {
                return null;
            }
            if (!isAllowedMediaUrl(next.href)) return null;
            current = next.href;
            continue;
        }

        if (!res.ok) {
            try { await res.body?.cancel(); } catch { }
            return null;
        }

        const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_DOWNLOAD;
        const lenHeader = res.headers.get("content-length");
        if (lenHeader) {
            const len = Number(lenHeader);
            if (Number.isFinite(len) && len > cap) {
                try { await res.body?.cancel(); } catch { }
                return null;
            }
        }

        const body = res.body;
        if (!body || typeof body.getReader !== "function") return null;
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > cap) {
                try { await reader.cancel(); } catch { }
                return null;
            }
            chunks.push(value);
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const chunk of chunks) {
            out.set(chunk, off);
            off += chunk.byteLength;
        }
        const data = out.buffer;

        if (!data.byteLength || data.byteLength > cap) return null;

        const type = (res.headers.get("content-type") || "application/octet-stream").split(";")[0]!.trim();
        return { data, type };
    }

    return null;
}

export async function pickCacheDirectory(_e: unknown, defaultPath?: string) {
    const res = await dialog.showOpenDialog({
        title: "Choose FavoriteGifCache folder",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: defaultPath || getDefaultCacheDir(),
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
}

export async function ensureCacheDir(_e: unknown, dir: string) {
    if (!dir || typeof dir !== "string") throw new Error("Invalid cache directory");
    mkdirSync(dir, { recursive: true });
    mkdirSync(blobsDir(dir), { recursive: true });
    if (!existsSync(metaPath(dir))) writeMeta(dir, {});
    return true;
}

function readOneEntry(
    dir: string,
    key: string,
    info: { file?: string; mimeType?: string; useCount?: number; lastUsed?: number; createdAt?: number; size?: number; },
): NativeCacheRecord | null {
    try {
        const name = isSafeBlobFileName(info.file || "") ? info.file! : fileNameForKey(key);
        const file = resolveBlobPath(dir, name);
        if (!file || !existsSync(file)) return null;
        const buf = readFileSync(file);
        const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        return {
            key,
            data,
            mimeType: info.mimeType || "application/octet-stream",
            useCount: Number(info.useCount) || 0,
            lastUsed: Number(info.lastUsed) || 0,
            createdAt: Number(info.createdAt) || 0,
            size: typeof info.size === "number" ? info.size : buf.byteLength,
        };
    } catch {
        return null;
    }
}

export async function getEntry(_e: unknown, dir: string, key: string): Promise<NativeCacheRecord | null> {
    await ensureCacheDir(_e, dir);
    const info = readMeta(dir)[key];
    if (!info) return null;
    return readOneEntry(dir, key, info);
}

export async function loadAllEntries(_e: unknown, dir: string): Promise<NativeCacheRecord[]> {
    await ensureCacheDir(_e, dir);
    const meta = readMeta(dir);
    const out: NativeCacheRecord[] = [];

    for (const [key, info] of Object.entries(meta)) {
        const row = readOneEntry(dir, key, info);
        if (row) out.push(row);
    }
    return out;
}

export async function putEntry(_e: unknown, dir: string, entry: NativeCacheRecord) {
    await ensureCacheDir(_e, dir);
    const file = fileNameForKey(entry.key);
    const full = resolveBlobPath(dir, file);
    if (!full) throw new Error("Invalid cache key");
    const bytes = Buffer.from(entry.data);
    writeFileSync(full, bytes);

    const meta = readMeta(dir);
    meta[entry.key] = {
        file,
        mimeType: entry.mimeType || "application/octet-stream",
        useCount: entry.useCount || 0,
        lastUsed: entry.lastUsed || Date.now(),
        createdAt: entry.createdAt || Date.now(),
        size: entry.size || bytes.byteLength,
    };
    writeMeta(dir, meta);
}

export async function deleteEntry(_e: unknown, dir: string, key: string) {
    await ensureCacheDir(_e, dir);
    const meta = readMeta(dir);
    const info = meta[key];
    const name = info?.file && isSafeBlobFileName(info.file) ? info.file : fileNameForKey(key);
    const full = resolveBlobPath(dir, name);
    if (full && existsSync(full)) {
        try {
            unlinkSync(full);
        } catch {
        }
    }
    delete meta[key];
    writeMeta(dir, meta);
}

export async function deleteEntries(_e: unknown, dir: string, keys: string[]) {
    for (const key of keys) {
        await deleteEntry(_e, dir, key);
    }
}

export async function clearCacheDir(_e: unknown, dir: string) {
    await ensureCacheDir(_e, dir);
    const bdir = blobsDir(dir);
    if (existsSync(bdir)) {
        for (const name of readdirSync(bdir)) {
            if (!isSafeBlobFileName(name)) continue;
            const full = resolveBlobPath(dir, name);
            if (!full) continue;
            try {
                unlinkSync(full);
            } catch {
            }
        }
    }
    writeMeta(dir, {});
}
