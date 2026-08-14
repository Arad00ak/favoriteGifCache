/*
 * Vencord / Equicord userplugin - FavoriteGifCache
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Single-file install. Source: https://github.com/Arad00ak/favoriteGifCache-source
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";
import type { PluginNative } from "@utils/types";
import { Menu, Toasts, useEffect, useState } from "@webpack/common";

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

const SOFT_MEMORY_BYTES = 80 * 1024 * 1024;

interface CacheMeta {
    key: string;
    useCount: number;
    lastUsed: number;
    size: number;
    mimeType: string;
    createdAt: number;
}

interface CacheEntry extends CacheMeta {
    data: Uint8Array;
}

interface CacheCoreOptions {
    maxBytes?: number;
    
    softMemoryBytes?: number;
    now?: () => number;
}

interface PutOptions {
    
    allowEvict?: boolean;
}

interface PutResult {
    stored: boolean;
    evictedKeys: string[];
    
    skippedFull?: boolean;
}

class GifCacheCore {
    private readonly entries = new Map<string, CacheEntry>();
    private maxBytes: number;
    private softMemoryBytes: number;
    private totalBytes = 0;
    private readonly now: () => number;
    
    private protectedKeys = new Set<string>();
    
    private displayPinnedKeys = new Set<string>();

    constructor(options: CacheCoreOptions = {}) {
        this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
        this.softMemoryBytes = options.softMemoryBytes ?? SOFT_MEMORY_BYTES;
        this.now = options.now ?? (() => Date.now());
    }

    getMaxBytes() {
        return this.maxBytes;
    }

    setMaxBytes(n: number) {
        this.maxBytes = n > 0 ? n : Number.POSITIVE_INFINITY;
        return this.enforceCap();
    }

    setProtectedKeys(keys: Iterable<string>) {
        this.protectedKeys = new Set(keys);
    }

    setDisplayPinnedKeys(keys: Iterable<string>) {
        this.displayPinnedKeys = new Set(keys);
    }

    size() {
        return this.entries.size;
    }

    bytes() {
        return this.totalBytes;
    }

    
    residentBytes() {
        let n = 0;
        for (const e of this.entries.values()) n += e.data.byteLength;
        return n;
    }

    keys() {
        return [...this.entries.keys()];
    }

    has(key: string) {
        return this.entries.has(key);
    }

    
    needsHydrate(key: string) {
        const entry = this.entries.get(key);
        return !!entry && entry.size > 0 && entry.data.byteLength === 0;
    }

    hasResidentData(key: string) {
        const entry = this.entries.get(key);
        return !!entry && entry.data.byteLength > 0;
    }

    get(key: string): CacheEntry | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        this.touch(key);
        return { ...entry, data: entry.data.slice() };
    }

    peek(key: string): CacheEntry | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        return { ...entry, data: entry.data.slice() };
    }

    peekRef(key: string): CacheEntry | null {
        return this.entries.get(key) ?? null;
    }

    touch(key: string) {
        const entry = this.entries.get(key);
        if (!entry) return false;
        entry.useCount += 1;
        entry.lastUsed = this.now();
        return true;
    }

    getMeta(key: string): CacheMeta | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        const { data: _d, ...meta } = entry;
        return { ...meta };
    }

    
    put(
        key: string,
        data: Uint8Array,
        mimeType = "application/octet-stream",
        options: PutOptions = {},
    ): PutResult {
        if (!key) return { stored: false, evictedKeys: [] };

        const allowEvict = options.allowEvict === true;
        const payload = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
        const size = payload.byteLength;
        const evictedKeys: string[] = [];

        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= existing.size;
            this.entries.delete(key);
        }

        if (size > this.maxBytes && this.maxBytes !== Number.POSITIVE_INFINITY) {
            return { stored: false, evictedKeys };
        }

        while (this.totalBytes + size > this.maxBytes) {
            if (!allowEvict) {

                if (existing) {
                    this.entries.set(existing.key, existing);
                    this.totalBytes += existing.size;
                }
                return { stored: false, evictedKeys, skippedFull: true };
            }
            const victim = this.pickVictim(key);
            if (!victim) break;
            this.entries.delete(victim.key);
            this.totalBytes -= victim.size;
            evictedKeys.push(victim.key);
        }

        if (this.totalBytes + size > this.maxBytes) {
            if (existing) {
                this.entries.set(existing.key, existing);
                this.totalBytes += existing.size;
            }
            return { stored: false, evictedKeys, skippedFull: true };
        }

        const t = this.now();
        const entry: CacheEntry = {
            key,
            data: payload,
            size,
            mimeType: mimeType || "application/octet-stream",
            useCount: existing?.useCount ?? 0,
            lastUsed: t,
            createdAt: existing?.createdAt ?? t,
        };

        this.entries.set(key, entry);
        this.totalBytes += size;
        this.ensureSoftMemory(key);
        return { stored: true, evictedKeys };
    }

    delete(key: string) {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.entries.delete(key);
        this.totalBytes -= entry.size;
        return true;
    }

    clear() {
        this.entries.clear();
        this.totalBytes = 0;
    }

    
    loadEntry(entry: CacheEntry) {
        const payload = entry.data instanceof Uint8Array
            ? entry.data.slice()
            : new Uint8Array(entry.data);
        const prev = this.entries.get(entry.key);
        if (prev) {
            this.totalBytes -= prev.size;
            this.entries.delete(entry.key);
        }

        const size = payload.byteLength > 0
            ? payload.byteLength
            : (typeof entry.size === "number" && entry.size > 0 ? entry.size : payload.byteLength);
        const next: CacheEntry = {
            key: entry.key,
            data: payload,
            size,
            mimeType: entry.mimeType || "application/octet-stream",
            useCount: entry.useCount ?? 0,
            lastUsed: entry.lastUsed ?? this.now(),
            createdAt: entry.createdAt ?? this.now(),
        };
        this.entries.set(next.key, next);
        this.totalBytes += next.size;
    }

    
    ensureSoftMemory(keepKey?: string): string[] {
        const unloaded: string[] = [];
        while (this.residentBytes() > this.softMemoryBytes) {
            const victim = this.pickDataVictim(keepKey);
            if (!victim) break;
            if (victim.data.byteLength === 0) break;
            victim.data = new Uint8Array(0);
            unloaded.push(victim.key);
        }
        return unloaded;
    }

    
    private pickDataVictim(exceptKey?: string): CacheEntry | null {
        let bestUnprotected: CacheEntry | null = null;
        let bestAny: CacheEntry | null = null;

        for (const entry of this.entries.values()) {
            if (exceptKey && entry.key === exceptKey) continue;
            if (entry.data.byteLength === 0) continue;

            if (this.displayPinnedKeys.has(entry.key)) continue;

            if (!this.protectedKeys.has(entry.key)) {
                if (!bestUnprotected || this.isWorse(entry, bestUnprotected)) {
                    bestUnprotected = entry;
                }
            }
            if (!bestAny || this.isWorse(entry, bestAny)) {
                bestAny = entry;
            }
        }

        return bestUnprotected ?? bestAny;
    }

    
    pickVictim(exceptKey?: string): CacheEntry | null {
        let bestUnprotected: CacheEntry | null = null;
        let bestAny: CacheEntry | null = null;

        for (const entry of this.entries.values()) {
            if (exceptKey && entry.key === exceptKey) continue;

            if (!this.protectedKeys.has(entry.key)) {
                if (!bestUnprotected || this.isWorse(entry, bestUnprotected)) {
                    bestUnprotected = entry;
                }
            }
            if (!bestAny || this.isWorse(entry, bestAny)) {
                bestAny = entry;
            }
        }

        return bestUnprotected ?? bestAny;
    }

    private isWorse(a: CacheEntry, b: CacheEntry) {
        if (a.useCount !== b.useCount) return a.useCount < b.useCount;
        if (a.lastUsed !== b.lastUsed) return a.lastUsed < b.lastUsed;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
        return a.key < b.key;
    }

    private enforceCap(): string[] {
        const evicted: string[] = [];
        while (this.totalBytes > this.maxBytes) {
            const victim = this.pickVictim();
            if (!victim) break;
            this.entries.delete(victim.key);
            this.totalBytes -= victim.size;
            evicted.push(victim.key);
        }
        return evicted;
    }
}

interface StorageBackend {
    readonly name: string;
    open(): Promise<void>;
    close(): Promise<void>;
    getAll(): Promise<CacheEntry[]>;
    get(key: string): Promise<CacheEntry | null>;
    put(entry: CacheEntry): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    deleteMany(keys: string[]): Promise<void>;
}

const DB_NAME = "FavoriteGifCache";
const DB_VERSION = 1;
const STORE = "gifs";

function toEntry(raw: any): CacheEntry {
    let data: Uint8Array;
    if (raw.data instanceof Uint8Array) {
        data = raw.data;
    } else if (raw.data instanceof ArrayBuffer) {
        data = new Uint8Array(raw.data);
    } else if (ArrayBuffer.isView(raw.data)) {
        data = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
    } else {
        data = new Uint8Array(0);
    }

    return {
        key: String(raw.key),
        data,
        size: typeof raw.size === "number" ? raw.size : data.byteLength,
        mimeType: raw.mimeType || "application/octet-stream",
        useCount: Number(raw.useCount) || 0,
        lastUsed: Number(raw.lastUsed) || 0,
        createdAt: Number(raw.createdAt) || 0,
    };
}

class MemoryStorageBackend implements StorageBackend {
    readonly name = "memory";
    private map = new Map<string, CacheEntry>();

    async open() {}
    async close() {}

    async getAll() {
        return [...this.map.values()].map(e => ({ ...e, data: e.data.slice() }));
    }

    async get(key: string) {
        const e = this.map.get(key);
        return e ? { ...e, data: e.data.slice() } : null;
    }

    async put(entry: CacheEntry) {
        this.map.set(entry.key, {
            ...entry,
            data: entry.data.slice(),
            size: entry.data.byteLength,
        });
    }

    async delete(key: string) {
        this.map.delete(key);
    }

    async clear() {
        this.map.clear();
    }

    async deleteMany(keys: string[]) {
        for (const k of keys) this.map.delete(k);
    }
}

class IndexedDBStorageBackend implements StorageBackend {
    readonly name = "indexeddb";
    private db: IDBDatabase | null = null;

    async open() {
        if (typeof indexedDB === "undefined") {
            throw new Error("IndexedDB unavailable");
        }
        if (this.db) return;

        this.db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: "key" });
                    store.createIndex("useCount", "useCount", { unique: false });
                    store.createIndex("lastUsed", "lastUsed", { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    async close() {
        this.db?.close();
        this.db = null;
    }

    private store(mode: IDBTransactionMode) {
        if (!this.db) throw new Error("IndexedDB not open");
        return this.db.transaction(STORE, mode).objectStore(STORE);
    }

    async getAll() {
        await this.open();
        return new Promise<CacheEntry[]>((resolve, reject) => {
            const req = this.store("readonly").getAll();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(((req.result as any[]) || []).map(toEntry));
        });
    }

    async get(key: string) {
        await this.open();
        return new Promise<CacheEntry | null>((resolve, reject) => {
            const req = this.store("readonly").get(key);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result ? toEntry(req.result) : null);
        });
    }

    async put(entry: CacheEntry) {
        await this.open();
        const record = {
            key: entry.key,
            data: entry.data.slice().buffer,
            size: entry.data.byteLength,
            mimeType: entry.mimeType,
            useCount: entry.useCount,
            lastUsed: entry.lastUsed,
            createdAt: entry.createdAt,
        };
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").put(record);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async delete(key: string) {
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").delete(key);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async clear() {
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").clear();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async deleteMany(keys: string[]) {
        if (!keys.length) return;
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const tx = this.db!.transaction(STORE, "readwrite");
            const store = tx.objectStore(STORE);
            for (const k of keys) store.delete(k);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

class FileStorageBackend implements StorageBackend {
    readonly name = "filesystem";
    constructor(
        private readonly dir: string,
        private readonly api: {
            ensureCacheDir(dir: string): Promise<unknown>;
            getEntry(dir: string, key: string): Promise<{
                key: string;
                data: ArrayBuffer;
                mimeType: string;
                useCount: number;
                lastUsed: number;
                createdAt: number;
                size: number;
            } | null>;
            loadAllEntries(dir: string): Promise<Array<{
                key: string;
                data: ArrayBuffer;
                mimeType: string;
                useCount: number;
                lastUsed: number;
                createdAt: number;
                size: number;
            }>>;
            putEntry(dir: string, entry: {
                key: string;
                data: ArrayBuffer;
                mimeType: string;
                useCount: number;
                lastUsed: number;
                createdAt: number;
                size: number;
            }): Promise<unknown>;
            deleteEntry(dir: string, key: string): Promise<unknown>;
            deleteEntries(dir: string, keys: string[]): Promise<unknown>;
            clearCacheDir(dir: string): Promise<unknown>;
        },
    ) {}

    get directory() {
        return this.dir;
    }

    async open() {
        await this.api.ensureCacheDir(this.dir);
    }

    async close() {}

    async getAll(): Promise<CacheEntry[]> {
        const rows = await this.api.loadAllEntries(this.dir);
        return rows.map(r => toEntry({
            key: r.key,
            data: r.data,
            mimeType: r.mimeType,
            useCount: r.useCount,
            lastUsed: r.lastUsed,
            createdAt: r.createdAt,
            size: r.size,
        }));
    }

    async get(key: string) {
        try {
            if (typeof this.api.getEntry === "function") {
                const row = await this.api.getEntry(this.dir, key);
                return row ? toEntry(row) : null;
            }
        } catch {
        }
        const all = await this.getAll();
        return all.find(e => e.key === key) ?? null;
    }

    async put(entry: CacheEntry) {
        const copy = entry.data.slice();
        await this.api.putEntry(this.dir, {
            key: entry.key,
            data: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
            mimeType: entry.mimeType,
            useCount: entry.useCount,
            lastUsed: entry.lastUsed,
            createdAt: entry.createdAt,
            size: entry.data.byteLength,
        });
    }

    async delete(key: string) {
        await this.api.deleteEntry(this.dir, key);
    }

    async clear() {
        await this.api.clearCacheDir(this.dir);
    }

    async deleteMany(keys: string[]) {
        if (!keys.length) return;
        await this.api.deleteEntries(this.dir, keys);
    }
}

function createDefaultBackend(): StorageBackend {
    if (typeof indexedDB !== "undefined") return new IndexedDBStorageBackend();
    return new MemoryStorageBackend();
}

function createBackendForPath(
    cacheDir: string | undefined | null,
    nativeApi: FileStorageBackend["api"] | null,
): StorageBackend {
    const dir = (cacheDir || "").trim();
    if (dir && nativeApi) {
        return new FileStorageBackend(dir, nativeApi);
    }
    return createDefaultBackend();
}

const KLIPY_MEDIA_HOSTS = [
    "static.klipy.com",
    "media.klipy.com",
    "cdn.klipy.com",
    "gifs.klipy.com",
    "i.klipy.com",
    "media1.klipy.com",
    "media2.klipy.com",
    "c.klipy.com",
    "klipy.com",
] as const;

const ALL_ALLOWED_HOSTS = [
    "media.tenor.com",
    "c.tenor.com",
    "tenor.com",
    ...KLIPY_MEDIA_HOSTS,
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
    "discord.com",
    "discordapp.com",
    "discordapp.net",
] as const;

function hostAllowed(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    for (const allowed of ALL_ALLOWED_HOSTS) {
        if (h === allowed || h.endsWith("." + allowed)) return true;
    }
    return false;
}

function isTenorUrl(url: string): boolean {
    try {
        const h = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
        return h === "tenor.com" || h.endsWith(".tenor.com");
    } catch {
        return false;
    }
}

function tenorToKlipyFallbackUrls(url: string): string[] {
    if (!isTenorUrl(url)) return [];
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return [];
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (const host of KLIPY_MEDIA_HOSTS) {
        try {
            const u = new URL(parsed.href);
            u.hostname = host;
            u.protocol = "https:";
            const href = u.href;
            if (seen.has(href)) continue;
            seen.add(href);
            out.push(href);
        } catch {
        }
    }
    return out;
}

function mediaDownloadCandidates(url: string): string[] {
    if (!url) return [];
    const out = [url];
    const seen = new Set([url]);
    for (const alt of tenorToKlipyFallbackUrls(url)) {
        if (seen.has(alt)) continue;
        seen.add(alt);
        out.push(alt);
    }
    return out;
}

const lookupMemo = new Map<string, string[]>();

function mediaLookupKeys(url: string): string[] {
    if (!url) return [];
    const hit = lookupMemo.get(url);
    if (hit) return hit;

    const keys: string[] = [];
    const seen = new Set<string>();
    const add = (k: string) => {
        if (!k || seen.has(k)) return;
        seen.add(k);
        keys.push(k);
    };

    add(url);
    try {
        const u = new URL(url);
        if (hostAllowed(u.hostname)) add(`${u.origin}${u.pathname}`);
        add(u.href);
    } catch {
    }

    if (lookupMemo.size > 1500) lookupMemo.clear();
    lookupMemo.set(url, keys);
    return keys;
}

function sniffMime(data: Uint8Array, fallback = "application/octet-stream"): string {
    if (!data || data.byteLength < 4) return fallback;

    if (
        data.byteLength >= 6
        && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46
        && data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61
    ) {
        return "image/gif";
    }

    if (
        data.byteLength >= 8
        && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    ) {
        return "image/png";
    }

    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return "image/jpeg";
    }

    if (
        data.byteLength >= 12
        && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
        && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
        return "image/webp";
    }

    if (
        data.byteLength >= 12
        && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70
    ) {
        return "video/mp4";
    }

    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
        return "video/webm";
    }

    return fallback;
}

interface FavoriteGifCacheOptions extends CacheCoreOptions {
    backend?: StorageBackend;
    
    smartEviction?: boolean;
}

interface BlobUrlOptions {
    
    bumpUsage?: boolean;
}

class FavoriteGifCache {
    private readonly core: GifCacheCore;
    private readonly backend: StorageBackend;
    private smartEviction: boolean;
    private ready: Promise<void> | null = null;
    private initDone = false;
    private blobUrls = new Map<string, string>();
    private liveBlobs = new Set<string>();
    private metaPersistQueue = new Map<string, ReturnType<typeof setTimeout>>();
    private revokeListener: ((blobUrl: string) => void) | null = null;

    constructor(options: FavoriteGifCacheOptions = {}) {
        this.core = new GifCacheCore(options);
        this.backend = options.backend ?? createDefaultBackend();
        this.smartEviction = options.smartEviction !== false;
    }

    setSmartEviction(enabled: boolean) {
        this.smartEviction = enabled;
    }

    isInitialized() {
        return this.initDone;
    }

    setRevokeListener(fn: ((blobUrl: string) => void) | null) {
        this.revokeListener = fn;
    }

    async init() {
        if (!this.ready) {
            this.ready = (async () => {
                await this.backend.open();
                const all = await this.backend.getAll();

                for (const entry of all) this.core.loadEntry(entry);

                const before = new Set(this.core.keys());
                const removed = this.core.setMaxBytes(this.core.getMaxBytes());
                const gone = removed.length
                    ? removed
                    : [...before].filter(k => !this.core.has(k));
                if (gone.length) {
                    await this.backend.deleteMany(gone);
                    for (const k of gone) this.revokeBlob(k);
                }

                this.core.ensureSoftMemory();

                this.initDone = true;
            })();
        }
        await this.ready;
    }

    
    async hydrate(key: string): Promise<boolean> {
        await this.init();
        if (!this.core.has(key)) return false;
        if (this.core.hasResidentData(key)) return true;

        const fromDisk = await this.backend.get(key);
        if (!fromDisk || fromDisk.data.byteLength === 0) return false;
        this.core.loadEntry(fromDisk);
        this.core.ensureSoftMemory(key);
        return this.core.hasResidentData(key);
    }

    getMaxBytes() {
        return this.core.getMaxBytes();
    }

    async setMaxBytes(n: number) {
        await this.init();
        const before = new Set(this.core.keys());
        this.core.setMaxBytes(n);
        const removed = [...before].filter(k => !this.core.has(k));
        if (removed.length) {
            await this.backend.deleteMany(removed);
            for (const k of removed) this.revokeBlob(k);
        }
    }

    
    setProtectedKeys(keys: Iterable<string>) {
        this.core.setProtectedKeys(keys);
    }

    
    setDisplayPinnedKeys(keys: Iterable<string>) {
        this.core.setDisplayPinnedKeys(keys);
    }

    size() {
        return this.core.size();
    }

    bytes() {
        return this.core.bytes();
    }

    has(key: string) {
        return this.core.has(key);
    }

    hasResidentData(key: string) {
        return this.core.hasResidentData(key);
    }

    keys() {
        return this.core.keys();
    }

    peekSync(key: string) {
        return this.core.peek(key);
    }

    touchSync(key: string) {
        if (!this.core.touch(key)) return false;
        const entry = this.core.peekRef(key);
        if (entry) this.scheduleMetaPersist(entry);
        return true;
    }

    
    async put(
        key: string,
        data: Uint8Array,
        mimeType = "application/octet-stream",
        options: PutOptions = {},
    ): Promise<PutResult> {
        await this.init();
        const allowEvict = this.smartEviction && options.allowEvict === true;
        const result = this.core.put(key, data, mimeType, { allowEvict });

        if (result.evictedKeys.length) {
            await this.backend.deleteMany(result.evictedKeys);
            for (const k of result.evictedKeys) this.revokeBlob(k);
        }

        if (result.stored) {
            const stored = this.core.peekRef(key);
            if (stored && stored.data.byteLength > 0) {
                await this.backend.put(stored);
                if (!this.blobUrls.has(key)) this.ensureBlobUrlSync(key, { bumpUsage: false });
            }
        }

        return result;
    }

    async delete(key: string) {
        await this.init();
        const ok = this.core.delete(key);
        if (ok) {
            await this.backend.delete(key);
            this.revokeBlob(key);
        }
        return ok;
    }

    async clear() {
        await this.init();
        for (const k of [...this.blobUrls.keys()]) this.revokeBlob(k);
        this.core.clear();
        await this.backend.clear();
    }

    ensureBlobUrlSync(key: string, opts: BlobUrlOptions = {}): string | null {
        if (!key) return null;
        if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
            return null;
        }

        const bump = opts.bumpUsage !== false;
        const existing = this.blobUrls.get(key);
        if (existing) {
            if (bump) this.touchSync(key);
            return existing;
        }

        if (this.core.needsHydrate(key)) return null;

        const entry = this.core.peekRef(key);
        if (!entry || entry.data.byteLength === 0) return null;
        if (bump) this.touchSync(key);

        try {
            const copy = entry.data.slice();
            const mime = sniffMime(copy, entry.mimeType || "application/octet-stream");
            const blob = new Blob([copy], { type: mime || "application/octet-stream" });
            if (blob.size <= 0) return null;
            const url = URL.createObjectURL(blob);
            this.blobUrls.set(key, url);
            this.liveBlobs.add(url);
            if (mime && mime !== entry.mimeType) entry.mimeType = mime;
            return url;
        } catch {
            return null;
        }
    }

    
    async ensureBlobUrl(key: string, opts: BlobUrlOptions = {}): Promise<string | null> {
        await this.init();
        if (this.core.needsHydrate(key)) {
            await this.hydrate(key);
        }
        return this.ensureBlobUrlSync(key, opts);
    }

    resolveDisplayHitSync(remoteUrl: string, opts: BlobUrlOptions = {}): { blobUrl: string; mimeType?: string; key: string; } | null {
        if (!remoteUrl || remoteUrl.startsWith("blob:") || remoteUrl.startsWith("data:")) {
            return null;
        }

        const bump = opts.bumpUsage !== false;
        const candidates = mediaLookupKeys(remoteUrl);

        for (const key of candidates) {
            const hot = this.blobUrls.get(key);
            if (hot) {
                if (bump) this.touchSync(key);
                const meta = this.core.getMeta(key);
                return { blobUrl: hot, mimeType: meta?.mimeType, key };
            }
        }

        for (const key of candidates) {
            const created = this.ensureBlobUrlSync(key, { bumpUsage: bump });
            if (created) {
                const meta = this.core.getMeta(key);
                return { blobUrl: created, mimeType: meta?.mimeType, key };
            }
        }

        return null;
    }

    isLiveBlobUrl(blobUrl: string) {
        return !!blobUrl && this.liveBlobs.has(blobUrl);
    }

    private scheduleMetaPersist(entry: CacheEntry) {

        if (entry.data.byteLength === 0 && entry.size > 0) return;

        const prev = this.metaPersistQueue.get(entry.key);
        if (prev) clearTimeout(prev);

        const t = setTimeout(() => {
            this.metaPersistQueue.delete(entry.key);
            const latest = this.core.peekRef(entry.key);
            if (!latest || (latest.data.byteLength === 0 && latest.size > 0)) return;
            void this.backend.put(latest).catch(() => {});
        }, 50);
        this.metaPersistQueue.set(entry.key, t);
    }

    private revokeBlob(key: string) {
        const url = this.blobUrls.get(key);
        if (url) {
            this.liveBlobs.delete(url);
            try { this.revokeListener?.(url); } catch { }
            if (typeof URL !== "undefined" && URL.revokeObjectURL) {
                try { URL.revokeObjectURL(url); } catch { }
            }
        }
        this.blobUrls.delete(key);
    }
}

function createFavoriteGifCache(options: FavoriteGifCacheOptions = {}) {
    return new FavoriteGifCache({
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        softMemoryBytes: options.softMemoryBytes ?? SOFT_MEMORY_BYTES,
        backend: options.backend,
        now: options.now,
        smartEviction: options.smartEviction,
    });
}

interface FavoriteGifRef {
    url: string;
    src: string;
    width?: number;
    height?: number;
    format?: number;
    
    order?: number;
}

function getFrecencySettings(): any | null {
    try {
        const ac = UserSettingsActionCreators?.FrecencyUserSettingsActionCreators;
        if (ac && typeof ac.getCurrentValue === "function") return ac;
    } catch {
    }
    try {
        const w = (globalThis as any).Vencord?.Webpack?.find
            ?? (globalThis as any).Equicord?.Webpack?.find;
        if (typeof w !== "function") return null;
        const found = w(
            (m: any) => typeof m?.ProtoClass?.typeName === "string"
                && m.ProtoClass.typeName.endsWith(".FrecencyUserSettings"),
        );
        return found?.getCurrentValue ? found : null;
    } catch {
        return null;
    }
}

function requestFavoriteGifsLoad() {
    try {
        UserSettingsActionCreators?.FrecencyUserSettingsActionCreators?.loadIfNecessary?.();
    } catch {
    }
}

function getFavoriteGifRefsFromFrecency(): FavoriteGifRef[] {
    try {
        const FrecencyUserSettings = getFrecencySettings();
        if (!FrecencyUserSettings?.getCurrentValue) return [];

        const value = FrecencyUserSettings.getCurrentValue();
        const gifs = value?.favoriteGifs?.gifs;
        if (!gifs || typeof gifs !== "object") return [];

        const out: FavoriteGifRef[] = [];
        for (const [key, meta] of Object.entries(gifs as Record<string, any>)) {
            const url = typeof meta?.url === "string" ? meta.url : key;
            const src = typeof meta?.src === "string" ? meta.src : url;
            if (!url && !src) continue;
            out.push({
                url: url || src,
                src: src || url,
                width: meta?.width,
                height: meta?.height,
                format: meta?.format,
                order: meta?.order,
            });
        }
        return sortFavoritesNewestFirst(out);
    } catch {
        return [];
    }
}

function sortFavoritesNewestFirst(refs: FavoriteGifRef[]): FavoriteGifRef[] {
    return [...refs].sort((a, b) => {
        const ao = typeof a.order === "number" ? a.order : Number.NEGATIVE_INFINITY;
        const bo = typeof b.order === "number" ? b.order : Number.NEGATIVE_INFINITY;
        if (bo !== ao) return bo - ao;

        const au = a.src || a.url || "";
        const bu = b.src || b.url || "";
        return bu < au ? -1 : bu > au ? 1 : 0;
    });
}

function prefetchTargetBytes(maxBytes: number): number {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0;
    return Math.max(1, Math.floor(maxBytes / 3));
}

function cacheKeyForUrl(url: string) {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (hostAllowed(u.hostname)) {
            return `${u.origin}${u.pathname}`;
        }
        return u.href;
    } catch {
        return url;
    }
}

function keysForFavorite(ref: FavoriteGifRef) {
    const keys = new Set<string>();
    if (ref.url) {
        for (const k of mediaLookupKeys(ref.url)) keys.add(k);
    }
    if (ref.src) {
        for (const k of mediaLookupKeys(ref.src)) keys.add(k);
    }
    return [...keys];
}

function isLikelyGifMediaUrl(url: string) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return false;
        return hostAllowed(u.hostname);
    } catch {
        return false;
    }
}

function isHeavyVideoUrl(url: string) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    try {
        const path = new URL(url).pathname.toLowerCase();
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(path);
    } catch {
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
    }
}

const GIF_FORMAT_IMAGE = 1;
const GIF_FORMAT_VIDEO = 2;

function isBlobOrDataUrl(url: unknown): url is string {
    return typeof url === "string" && (url.startsWith("blob:") || url.startsWith("data:"));
}

function isRemoteHttpUrl(url: unknown): url is string {
    return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

function isVideoMime(mime: string | null | undefined): boolean {
    if (!mime) return false;
    const m = mime.toLowerCase().split(";")[0]!.trim();
    return m.startsWith("video/") || m === "application/mp4";
}

function isImageMime(mime: string | null | undefined): boolean {
    if (!mime) return false;
    const m = mime.toLowerCase().split(";")[0]!.trim();
    return m.startsWith("image/");
}

function mimeMatchesFormat(format: number | undefined, mime: string | null | undefined): boolean {
    const f = typeof format === "number" ? format : GIF_FORMAT_IMAGE;
    if (f === GIF_FORMAT_VIDEO) return isVideoMime(mime);
    if (isVideoMime(mime)) return false;
    if (!mime || mime === "application/octet-stream") return true;
    return isImageMime(mime);
}

function stashOriginalUrls(gif: any): void {
    if (!gif || typeof gif !== "object") return;

    if (!isRemoteHttpUrl(gif.__fgcOriginalSrc)) {
        if (isRemoteHttpUrl(gif.src)) gif.__fgcOriginalSrc = gif.src;
        else if (isRemoteHttpUrl(gif.url)) gif.__fgcOriginalSrc = gif.url;
    }

    if (!isRemoteHttpUrl(gif.__fgcOriginalUrl)) {
        if (isRemoteHttpUrl(gif.url)) gif.__fgcOriginalUrl = gif.url;
        else if (isRemoteHttpUrl(gif.src)) gif.__fgcOriginalUrl = gif.src;
    }

    if (typeof gif.__fgcOriginalFormat !== "number" && typeof gif.format === "number") {
        gif.__fgcOriginalFormat = gif.format;
    }
}

function remoteSendUrl(gif: any): string | null {
    if (!gif || typeof gif !== "object") return null;
    for (const c of [
        gif.__fgcOriginalUrl,
        gif.__fgcOriginalSrc,
        isBlobOrDataUrl(gif.url) ? null : gif.url,
        isBlobOrDataUrl(gif.src) ? null : gif.src,
    ]) {
        if (isRemoteHttpUrl(c)) return c;
    }
    return null;
}

function remoteDisplaySrc(gif: any): string {
    if (!gif || typeof gif !== "object") return "";
    for (const c of [
        gif.__fgcOriginalSrc,
        gif.__fgcOriginalUrl,
        isBlobOrDataUrl(gif.src) ? null : gif.src,
        isBlobOrDataUrl(gif.url) ? null : gif.url,
    ]) {
        if (isRemoteHttpUrl(c)) return c;
    }
    return "";
}

function restoreUrlsForSend(gif: any): void {
    if (!gif || typeof gif !== "object") return;
    stashOriginalUrls(gif);
    const sendUrl = remoteSendUrl(gif);
    const displaySrc = remoteDisplaySrc(gif) || sendUrl;
    if (sendUrl) gif.url = sendUrl;
    if (displaySrc) gif.src = displaySrc;
    if (typeof gif.__fgcOriginalFormat === "number") gif.format = gif.__fgcOriginalFormat;
}

function healFavoriteUrls(gif: any): void {
    if (!gif || typeof gif !== "object") return;
    if (isBlobOrDataUrl(gif.src) || isBlobOrDataUrl(gif.url)) restoreUrlsForSend(gif);
}

const STORE_KEY = "FavoriteGifCache.autoCacheDenylist";

let denied = new Set<string>();

function keysFor(url: string) {
    const k = cacheKeyForUrl(url);
    return k === url ? [url] : [k, url];
}

async function loadDenylist() {
    try {
        const arr = (await DataStore.get(STORE_KEY)) as string[] | undefined;
        denied = new Set(Array.isArray(arr) ? arr : []);
    } catch {
        denied = new Set();
    }
}

async function persist() {
    await DataStore.set(STORE_KEY, [...denied]);
}

function isAutoCacheDenied(url: string) {
    if (!url) return false;
    for (const k of keysFor(url)) {
        if (denied.has(k)) return true;
    }
    return false;
}

async function denyAutoCache(url: string) {
    for (const k of keysFor(url)) denied.add(k);
    await persist();
}

async function allowAutoCache(url: string) {
    for (const k of keysFor(url)) denied.delete(k);
    await persist();
}

type Native = PluginNative<typeof import("./native")>;

function getPluginNative(): Native | null {
    try {
        const helpers =
            (typeof VencordNative !== "undefined" && (VencordNative as any)?.pluginHelpers)
            || (globalThis as any).VencordNative?.pluginHelpers
            || (globalThis as any).EquicordNative?.pluginHelpers
            || null;

        if (!helpers || typeof helpers !== "object") return null;

        const n =
            helpers.FavoriteGifCache
            ?? helpers.favoriteGifCache
            ?? null;

        if (n && typeof n.pickCacheDirectory === "function") return n as Native;
        return null;
    } catch {
        return null;
    }
}

const inflight = new Map<string, Promise<{ data: Uint8Array; mime: string; } | null>>();

const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

function guessMime(url: string, contentType: string | null, data?: Uint8Array) {

    if (data && data.byteLength >= 4) {
        const sniffed = sniffMime(data, "");
        if (sniffed) return sniffed;
    }
    if (contentType && !contentType.includes("octet-stream")) {
        return contentType.split(";")[0]!.trim();
    }
    const path = url.split("?")[0]!.toLowerCase();
    if (path.endsWith(".mp4")) return "video/mp4";
    if (path.endsWith(".webm")) return "video/webm";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    return "image/gif";
}

function isDownloadableUrl(url: string) {
    try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return false;
        return hostAllowed(u.hostname);
    } catch {
        return false;
    }
}

async function downloadOneUrl(
    url: string,
    fetchImpl: typeof fetch,
    maxBytes: number,
): Promise<{ data: Uint8Array; mime: string; } | null> {
    if (!isDownloadableUrl(url)) return null;

    const native = getPluginNative();
    if (native && typeof (native as any).fetchMedia === "function") {
        try {
            const res = await (native as any).fetchMedia(url, maxBytes);
            if (res?.data) {
                const data = res.data instanceof ArrayBuffer
                    ? new Uint8Array(res.data)
                    : new Uint8Array(res.data);
                if (data.byteLength && data.byteLength <= maxBytes) {
                    return {
                        data,
                        mime: guessMime(url, res.type || null, data),
                    };
                }
            }
        } catch {
        }
    }

    try {
        const res = await fetchImpl(url, {
            credentials: "omit",
            cache: "no-store",
            mode: "cors",
            redirect: "error",
        } as RequestInit);
        if (!res.ok) return null;
        const lenHeader = res.headers.get("content-length");
        if (lenHeader) {
            const len = Number(lenHeader);
            if (Number.isFinite(len) && len > maxBytes) return null;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength || buf.byteLength > maxBytes) return null;
        const mime = guessMime(url, res.headers.get("content-type"), buf);
        return { data: buf, mime };
    } catch {
        return null;
    }
}

async function downloadFavoriteMedia(
    url: string,
    fetchImpl: typeof fetch = fetch,
    maxBytes = MAX_ENTRY_BYTES,
): Promise<{ data: Uint8Array; mime: string; fromUrl?: string; } | null> {
    const candidates = mediaDownloadCandidates(url);
    for (const candidate of candidates) {
        const hit = await downloadOneUrl(candidate, fetchImpl, maxBytes);
        if (hit) return { ...hit, fromUrl: candidate };
    }
    return null;
}

async function getCachedBytes(cache: FavoriteGifCache, url: string) {
    await cache.init();

    for (const key of mediaLookupKeys(url)) {
        if (!cache.has(key)) continue;
        if (!cache.hasResidentData(key)) {
            await cache.hydrate(key);
        }
        const entry = cache.peekSync(key);
        if (entry && entry.data.byteLength > 0) {
            cache.touchSync(entry.key);
            return { data: entry.data.slice(), mimeType: entry.mimeType, key: entry.key };
        }
    }

    return null;
}

type EnsureCachedOptions = {
    fetchImpl?: typeof fetch;
    allowEvict?: boolean;
    maxBytes?: number;
    
    force?: boolean;
    
    isDenied?: (url: string) => boolean;
};

async function ensureCached(
    cache: FavoriteGifCache,
    url: string,
    fetchImplOrOpts: typeof fetch | EnsureCachedOptions = fetch,
) {
    if (!url || !isLikelyGifMediaUrl(url)) return null;

    const opts: EnsureCachedOptions = typeof fetchImplOrOpts === "function"
        ? { fetchImpl: fetchImplOrOpts }
        : fetchImplOrOpts;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const allowEvict = opts.allowEvict === true;
    const maxBytes = opts.maxBytes ?? MAX_ENTRY_BYTES;
    const force = opts.force === true;

    if (!force && opts.isDenied?.(url)) return null;

    const key = cacheKeyForUrl(url);
    const hit = await getCachedBytes(cache, url);
    if (hit) {
        return { ...hit, fromCache: true as const, stored: true as const };
    }

    let pending = inflight.get(key);
    if (!pending) {
        pending = (async () => {
            try {
                return await downloadFavoriteMedia(url, fetchImpl, maxBytes);
            } catch {
                return null;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, pending);
    }

    const downloaded = await pending;
    if (!downloaded) return null;

    if (downloaded.data.byteLength > maxBytes) {
        return null;
    }

    await cache.put(key, downloaded.data, downloaded.mime, { allowEvict });

    const fromKey = downloaded.fromUrl ? cacheKeyForUrl(downloaded.fromUrl) : null;
    if (fromKey && fromKey !== key) {
        await cache.put(fromKey, downloaded.data, downloaded.mime, { allowEvict: false });
    }

    let entry = cache.peekSync(key);
    if (!entry && allowEvict) {
        await cache.put(key, downloaded.data, downloaded.mime, { allowEvict: true });
        entry = cache.peekSync(key);
    }

    return {
        data: downloaded.data,
        mimeType: entry?.mimeType || downloaded.mime,
        key,
        fromCache: false as const,
        stored: !!entry,
    };
}

async function cacheOnUserAction(
    cache: FavoriteGifCache,
    url: string,
    fetchImpl: typeof fetch = fetch,
    opts: {
        force?: boolean;
        isDenied?: (url: string) => boolean;
        maxBytes?: number;
    } = {},
) {
    return ensureCached(cache, url, {
        fetchImpl,
        allowEvict: true,
        force: opts.force === true,
        isDenied: opts.isDenied,
        maxBytes: opts.maxBytes,
    });
}

let active: FavoriteGifCache | null = null;
let rebuild: (() => Promise<FavoriteGifCache>) | null = null;

function setActiveCache(cache: FavoriteGifCache | null) {
    active = cache;
}

function getActiveCache() {
    return active;
}

function setRebuildCache(fn: (() => Promise<FavoriteGifCache>) | null) {
    rebuild = fn;
}

async function rebuildActiveCache() {
    if (!rebuild) throw new Error("Cache rebuild is not ready");
    return rebuild();
}

let usageComponent: (() => any) | null = null;

function setUsageBarComponent(fn: () => any) {
    usageComponent = fn;
}

const settingsHooks = {
    onLimitsChange: () => {},
    onSmartEvictionChange: () => {},
    onCacheDirectoryChange: () => {},
};

const STALE_SETTING_KEYS = ["maxEntries", "showCacheBadges"] as const;

function purgeStalePluginSettings() {
    try {
        const plug = Settings.plugins?.FavoriteGifCache as Record<string, unknown> | undefined;
        if (!plug || typeof plug !== "object") return;
        for (const key of STALE_SETTING_KEYS) {
            if (Object.prototype.hasOwnProperty.call(plug, key)) {
                delete plug[key];
            }
        }
    } catch {

    }
}

const settings = definePluginSettings({
    cacheUsage: {
        type: OptionType.COMPONENT,
        description: "Storage",
        component: () => (usageComponent ? usageComponent() : null),
    },
    maxMegabytes: {
        type: OptionType.NUMBER,
        description: "Max space the cache can use (MB)",
        default: 500,
        onChange: () => settingsHooks.onLimitsChange(),
    },
    skipLargeFiles: {
        type: OptionType.BOOLEAN,
        description: "Don't save files bigger than 12 MB",
        default: true,
    },

    cacheDirectory: {
        type: OptionType.STRING,
        description: "Cache folder",
        default: "",
        hidden: true,
        onChange: () => settingsHooks.onCacheDirectoryChange(),
    },
    smartEviction: {
        type: OptionType.BOOLEAN,
        description: "When full, delete least-used GIFs to make room",
        default: true,
        onChange: () => settingsHooks.onSmartEvictionChange(),
    },
    prefetchOnStart: {
        type: OptionType.BOOLEAN,
        description: "Download some favorites in the background after Discord starts",
        default: true,
    },
    rewriteFavoriteSrc: {
        type: OptionType.BOOLEAN,
        description: "Show cached GIFs from disk in the picker (faster)",
        default: true,
    },
});

purgeStalePluginSettings();

function formatMB(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) return "0.0";
    return (bytes / (1024 * 1024)).toFixed(1);
}

function barColor(pct: number) {
    if (pct >= 90) return "var(--status-danger, #f23f43)";
    if (pct >= 70) return "var(--status-warning, #f0b232)";
    return "var(--brand-500, #5865f2)";
}

function showToast(message: string, type: any) {
    try {
        Toasts.show({
            message,
            type,
            id: Toasts.genId(),
        });
    } catch {

    }
}

function UsageBar(props: {
    label: string;
    valueText: string;
    percent: number;
}) {
    const pct = Math.max(0, Math.min(100, props.percent));
    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
                gap: 8,
            }}>
                <span style={{
                    color: "var(--header-secondary)",
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.02em",
                }}>
                    {props.label}
                </span>
                <span style={{
                    color: "var(--text-default)",
                    fontSize: 12,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                }}>
                    {props.valueText}
                </span>
            </div>
            <div style={{
                height: 8,
                borderRadius: 4,
                background: "var(--background-modifier-accent, #3f4147)",
                overflow: "hidden",
            }}>
                <div style={{
                    width: `${pct}%`,
                    height: "100%",
                    borderRadius: 4,
                    background: barColor(pct),
                    transition: "width 0.35s ease, background 0.35s ease",
                }} />
            </div>
        </div>
    );
}

function CacheUsageBar() {
    const [count, setCount] = useState(0);
    const [bytes, setBytes] = useState(0);
    const [maxBytes, setMaxBytes] = useState(DEFAULT_MAX_BYTES);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pathLabel, setPathLabel] = useState("");
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let alive = true;

        (async () => {
            try {
                const cache = getActiveCache() ?? await rebuildActiveCache().catch(() => null);
                if (!cache) {
                    if (alive) {
                        setReady(false);
                        setCount(0);
                        setBytes(0);
                    }
                    return;
                }
                await cache.init();
                if (!alive) return;
                setCount(cache.size());
                setBytes(cache.bytes());
                const mb = cache.getMaxBytes();
                setMaxBytes(Number.isFinite(mb) ? mb : DEFAULT_MAX_BYTES);
                const dir = (settings.store.cacheDirectory || "").trim();
                setPathLabel(dir || "Default (in Discord data)");
                setReady(true);
            } catch {
                if (alive) setReady(false);
            }
        })();

        return () => {
            alive = false;
        };
    }, [tick]);

    const bytePct = maxBytes > 0 ? (bytes / maxBytes) * 100 : 0;
    const usedMB = formatMB(bytes);
    const maxMB = formatMB(maxBytes);
    const leftMB = formatMB(Math.max(0, maxBytes - bytes));
    const hasCustomPath = !!(settings.store.cacheDirectory || "").trim();
    const gifLabel = count === 1 ? "1 GIF" : `${count} GIFs`;

    const onClear = async () => {
        setBusy(true);
        try {
            const cache = getActiveCache() ?? await rebuildActiveCache();
            await cache.clear();
            showToast("Favorite GIF cache cleared", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch {
            showToast("Failed to clear cache", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const onBrowse = async () => {
        const native = getPluginNative();
        if (!native?.pickCacheDirectory) {
            showToast("Folder picker unavailable - restart Discord after updating", Toasts.Type.FAILURE);
            return;
        }
        setBusy(true);
        try {
            let startPath = (settings.store.cacheDirectory || "").trim();
            if (!startPath && typeof native.getDefaultCacheDir === "function") {
                startPath = await native.getDefaultCacheDir();
            }
            const picked = await native.pickCacheDirectory(startPath || undefined);
            if (!picked) {
                setBusy(false);
                return;
            }
            if (typeof native.ensureCacheDir === "function") {
                await native.ensureCacheDir(picked);
            }
            settings.store.cacheDirectory = picked;
            await rebuildActiveCache();
            showToast("Cache folder updated", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch (e) {
            showToast(e instanceof Error ? e.message : "Could not set folder", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const onUseDefault = async () => {
        setBusy(true);
        try {
            settings.store.cacheDirectory = "";
            await rebuildActiveCache();
            showToast("Using default storage", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch {
            showToast("Failed to reset storage", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{
            marginTop: 4,
            marginBottom: 8,
            padding: 12,
            borderRadius: 8,
            background: "var(--background-secondary-alt, #2b2d31)",
            border: "1px solid var(--background-modifier-accent, #3f4147)",
        }}>
            <div style={{
                color: "var(--header-primary)",
                fontSize: 14,
                fontWeight: 600,
                marginBottom: 4,
            }}>
                Storage
            </div>
            <div style={{
                marginBottom: 12,
                color: "var(--text-muted)",
                fontSize: 13,
                lineHeight: "18px",
            }}>
                {ready
                    ? `${gifLabel} · ${leftMB} MB free`
                    : "Turn the plugin on to see usage."}
            </div>

            <UsageBar
                label="Size"
                valueText={`${usedMB} MB / ${maxMB} MB`}
                percent={bytePct}
            />

            <div style={{
                marginBottom: 10,
                color: "var(--text-muted)",
                fontSize: 12,
                wordBreak: "break-all",
            }}>
                <span style={{ fontWeight: 600, color: "var(--header-secondary)" }}>Location: </span>
                {pathLabel || "-"}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Button
                    size="small"
                    variant="dangerPrimary"
                    disabled={busy || !ready}
                    onClick={() => void onClear()}
                >
                    Clear cache
                </Button>
                <Button
                    size="small"
                    variant="primary"
                    disabled={busy}
                    onClick={() => void onBrowse()}
                >
                    Choose folder
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    disabled={busy || !hasCustomPath}
                    onClick={() => void onUseDefault()}
                >
                    Use default
                </Button>
            </div>
        </div>
    );
}

setUsageBarComponent(() => <CacheUsageBar />);

let cache: FavoriteGifCache | null = null;
let favoriteUrlSet = new Set<string>();

let favoritesSeeded = false;
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
let lastPickerInstance: { forceUpdate?: () => void; dead?: boolean } | null = null;
let emptyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let emptyRetryCount = 0;
let unsubSettings: (() => void) | null = null;
let mediaErrorBound = false;
let mediaObserver: MutationObserver | null = null;
let lastFavorites: any[] = [];
const pendingAddRefs = new Map<string, FavoriteGifRef>();
const pendingRemoveKeys = new Set<string>();
let favoriteDiffFlush: Promise<void> | null = null;
let favoritePoll: ReturnType<typeof setInterval> | null = null;
let wrapWork: Promise<void> | null = null;
let wrapWorkPending: {
    favorites: any[];
    refs: FavoriteGifRef[];
    visibleKeys: string[];
} | null = null;

function maxBytesFromSettings() {
    const mb = Number(settings.store.maxMegabytes);
    if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_MAX_BYTES;
    return Math.floor(mb * 1024 * 1024);
}

function perFileMaxBytes() {
    return settings.store.skipLargeFiles === false ? Number.MAX_SAFE_INTEGER : MAX_ENTRY_BYTES;
}

function createBackend() {
    const dir = (settings.store.cacheDirectory || "").trim();
    const native = getPluginNative();
    return createBackendForPath(dir, native);
}

function getCache() {
    if (!cache) {
        cache = createFavoriteGifCache({
            maxBytes: maxBytesFromSettings(),
            backend: createBackend(),
            smartEviction: settings.store.smartEviction !== false,
        });
        cache.setRevokeListener(onBlobRevoking);
        setActiveCache(cache);
    }
    return cache;
}

async function rebuildCache() {
    cache = null;
    setActiveCache(null);
    const c = getCache();
    await c.init();
    c.setSmartEviction(settings.store.smartEviction !== false);
    await applyLimitsFromSettings();
    return c;
}

setRebuildCache(rebuildCache);

async function applyLimitsFromSettings() {
    try {
        const c = getCache();
        await c.init();
        await c.setMaxBytes(maxBytesFromSettings());
        c.setSmartEviction(settings.store.smartEviction !== false);

    } catch {

    }
}

settingsHooks.onLimitsChange = () => { void applyLimitsFromSettings(); };
settingsHooks.onSmartEvictionChange = () => {
    try {
        getCache().setSmartEviction(settings.store.smartEviction !== false);
    } catch {

    }
};
settingsHooks.onCacheDirectoryChange = () => { void rebuildCache(); };

function refreshFavoriteSet(refs?: FavoriteGifRef[]): { added: string[]; removed: string[]; } {
    const list = refs ?? getFavoriteGifRefsFromFrecency();
    const next = new Set<string>();
    const primaryByKey = new Map<string, string>();

    for (const ref of list) {
        const primary = (isRemoteHttpUrl(ref.src) ? ref.src : "")
            || (isRemoteHttpUrl(ref.url) ? ref.url : "");
        if (!primary) continue;
        for (const k of keysForFavorite(ref)) {
            next.add(k);
            if (!primaryByKey.has(k)) primaryByKey.set(k, primary);
        }
    }

    const added: string[] = [];
    const removed: string[] = [];
    if (favoritesSeeded) {
        const seenPrimary = new Set<string>();
        for (const key of next) {
            if (favoriteUrlSet.has(key)) continue;
            const primary = primaryByKey.get(key);
            if (!primary || seenPrimary.has(primary)) continue;
            seenPrimary.add(primary);
            added.push(primary);
        }
        for (const key of favoriteUrlSet) {
            if (!next.has(key)) removed.push(key);
        }
    }

    favoriteUrlSet = next;
    favoritesSeeded = true;
    getCache().setProtectedKeys(next);
    return { added, removed };
}

function enqueueFavoriteDiff(added: string[], removed: string[], refs: FavoriteGifRef[]) {
    for (const ref of newRefsForUrls(added, refs)) {
        const id = (isRemoteHttpUrl(ref.url) ? ref.url : "") || ref.src || "";
        if (id) pendingAddRefs.set(id, ref);
    }
    for (const key of removed) pendingRemoveKeys.add(key);
    if (pendingAddRefs.size || pendingRemoveKeys.size) void flushFavoriteDiff();
}

function syncFromFrecency() {
    hookFavoriteUpdates();
    const refs = getFavoriteGifRefsFromFrecency();
    if (!refs.length) return;
    const { added, removed } = refreshFavoriteSet(refs);
    enqueueFavoriteDiff(added, removed, refs);
}

function hookFavoriteUpdates() {
    try {
        const ac = UserSettingsActionCreators?.FrecencyUserSettingsActionCreators;
        if (!ac || (ac as any).__fgcHooked) return;
        const orig = ac.updateAsync;
        if (typeof orig !== "function") return;
        (ac as any).__fgcHooked = true;
        let hookTimer: ReturnType<typeof setTimeout> | null = null;
        ac.updateAsync = function (this: any, key: string, ...rest: any[]) {
            const ret = orig.call(this, key, ...rest);
            if (key === "favoriteGifs") {
                if (hookTimer) clearTimeout(hookTimer);
                hookTimer = setTimeout(() => {
                    hookTimer = null;
                    try { syncFromFrecency(); } catch { }
                }, 50);
            }
            return ret;
        };
    } catch {
    }
}

async function flushFavoriteDiff() {
    if (favoriteDiffFlush) return favoriteDiffFlush;
    favoriteDiffFlush = (async () => {
        try {
            while (pendingAddRefs.size || pendingRemoveKeys.size) {
                const adds = [...pendingAddRefs.values()];
                pendingAddRefs.clear();
                const removes = [...pendingRemoveKeys];
                pendingRemoveKeys.clear();
                if (adds.length) await cacheNewFavoriteRefs(adds);
                if (removes.length) await evictUnfavoritedKeys(removes);
            }
        } finally {
            favoriteDiffFlush = null;
        }
    })();
    return favoriteDiffFlush;
}

async function evictUnfavoritedKeys(keys: string[]) {
    if (!keys.length) return;
    try {
        const c = getCache();
        await c.init();
        const drop = new Set<string>();
        for (const k of keys) {
            if (!k) continue;
            drop.add(k);
            drop.add(cacheKeyForUrl(k));
            for (const alt of mediaLookupKeys(k)) drop.add(alt);
        }
        for (const key of c.keys()) {
            if (!drop.has(key)) continue;
            if (favoriteUrlSet.has(key)) continue;
            try { await c.delete(key); } catch { }
        }
        scanPickerMedia();
    } catch {
    }
}

function isTrackedFavorite(url: string) {
    if (!url || !isLikelyGifMediaUrl(url)) return false;

    if (!favoritesSeeded || favoriteUrlSet.size === 0) return false;
    return favoriteUrlSet.has(url) || favoriteUrlSet.has(cacheKeyForUrl(url));
}

function newRefsForUrls(urls: string[], refs: FavoriteGifRef[]): FavoriteGifRef[] {
    if (!urls.length) return [];
    const want = new Set<string>();
    for (const u of urls) {
        if (!u) continue;
        want.add(u);
        want.add(cacheKeyForUrl(u));
        for (const k of mediaLookupKeys(u)) want.add(k);
    }
    return refs.filter(ref =>
        [ref.src, ref.url].some(u => !!u && (want.has(u) || want.has(cacheKeyForUrl(u)))),
    );
}

async function cacheNewFavoriteRefs(refs: FavoriteGifRef[]) {
    if (!refs.length) return;
    try {
        const c = getCache();
        await c.init();
        for (const ref of refs) {
            const tried = new Set<string>();
            const urls = [pickCacheableUrl(ref), ref.src, ref.url];
            for (const cacheUrl of urls) {
                if (!cacheUrl || !isLikelyGifMediaUrl(cacheUrl) || isAutoCacheDenied(cacheUrl)) continue;
                const key = cacheKeyForUrl(cacheUrl);
                if (tried.has(key)) continue;
                tried.add(key);
                try {
                    const res = await cacheOnUserAction(c, cacheUrl, fetch, autoCacheOpts());
                    if (res?.stored || c.has(key) || c.has(cacheUrl)) {
                        await c.ensureBlobUrl(key, { bumpUsage: false });
                        break;
                    }
                } catch {
                }
            }
        }
        for (const g of lastFavorites) applyCacheSrc(g, c);
        scanPickerMedia();
    } catch {
    }
}

function pickCacheableUrl(ref: { src?: string; url?: string; format?: number; }): string | null {
    const candidates = [ref.src, ref.url].filter((u): u is string => !!u && typeof u === "string");
    let format = ref.format;
    if (typeof format !== "number" && ref.src && isHeavyVideoUrl(ref.src)) format = GIF_FORMAT_VIDEO;
    if (format === GIF_FORMAT_VIDEO) {
        const videos = candidates.filter(u => isLikelyGifMediaUrl(u) && isHeavyVideoUrl(u));
        if (videos.length) return videos[0]!;
    }
    if (format === GIF_FORMAT_IMAGE) {
        const images = candidates.filter(u => isLikelyGifMediaUrl(u) && !isHeavyVideoUrl(u));
        if (images.length) return images[0]!;
    }
    for (const u of candidates) {
        if (isLikelyGifMediaUrl(u)) return u;
    }
    return null;
}

function safeForceUpdate(instance: any) {
    try {
        if (instance && !instance.dead && typeof instance.forceUpdate === "function") {
            instance.forceUpdate();
        }
    } catch {

    }
}

function scheduleEmptyRetry(instance: any) {
    if (emptyRetryCount >= 12) return;
    if (emptyRetryTimer) return;
    emptyRetryTimer = setTimeout(() => {
        emptyRetryTimer = null;
        emptyRetryCount += 1;
        requestFavoriteGifsLoad();
        safeForceUpdate(instance ?? lastPickerInstance);
    }, 150 + emptyRetryCount * 150);
}

function isPlayableMediaUrl(url: unknown): url is string {
    if (!isRemoteHttpUrl(url) || !isLikelyGifMediaUrl(url)) return false;
    try {
        const path = new URL(url).pathname.toLowerCase();
        if (path.includes("/view/") || path.endsWith(".html")) return false;
    } catch {
        return false;
    }
    return true;
}

function healStoreGif(gif: any, c: FavoriteGifCache | null = null) {
    if (!gif || typeof gif !== "object") return;
    healFavoriteUrls(gif);
    stashOriginalUrls(gif);
    const send = remoteSendUrl(gif);
    if (send && isRemoteHttpUrl(send)) gif.url = send;
    if (isBlobOrDataUrl(gif.src)) {
        if (c?.isLiveBlobUrl(gif.src)) return;
        const cdn = [gif.__fgcOriginalSrc, remoteDisplaySrc(gif), send].find(isPlayableMediaUrl);
        if (cdn) gif.src = cdn;
    }
}

function remoteCandidates(gif: any): string[] {
    const out: string[] = [];
    const push = (u: unknown) => {
        if (typeof u === "string" && isRemoteHttpUrl(u) && !out.includes(u)) out.push(u);
    };
    push(gif?.__fgcOriginalSrc);
    push(gif?.__fgcOriginalUrl);
    if (!isBlobOrDataUrl(gif?.src)) push(gif?.src);
    if (!isBlobOrDataUrl(gif?.url)) push(gif?.url);
    push(remoteDisplaySrc(gif));
    push(remoteSendUrl(gif));
    return out;
}

function applyCacheSrc(gif: any, c: FavoriteGifCache | null): boolean {
    healStoreGif(gif, c);
    if (!c?.isInitialized() || !settings.store.rewriteFavoriteSrc) return false;
    if (isBlobOrDataUrl(gif.src) && c.isLiveBlobUrl(gif.src)) return false;

    let format = typeof gif.format === "number"
        ? gif.format
        : (typeof gif.__fgcOriginalFormat === "number" ? gif.__fgcOriginalFormat : undefined);
    if (typeof format !== "number") {
        const hint = gif.__fgcOriginalSrc || remoteDisplaySrc(gif);
        format = hint && isHeavyVideoUrl(hint) ? GIF_FORMAT_VIDEO : GIF_FORMAT_IMAGE;
    }

    for (const remote of remoteCandidates(gif)) {
        const hit = c.resolveDisplayHitSync(remote, { bumpUsage: false });
        if (!hit?.blobUrl?.startsWith("blob:") || !mimeMatchesFormat(format, hit.mimeType)) continue;
        if (gif.src === hit.blobUrl) return false;
        gif.src = hit.blobUrl;
        return true;
    }
    return false;
}

function refsFromFavorites(favorites: any[]): FavoriteGifRef[] {
    const refs: FavoriteGifRef[] = [];
    for (const g of favorites) {
        const url = remoteSendUrl(g) || (isRemoteHttpUrl(g?.url) ? g.url : "") || "";
        const src = remoteDisplaySrc(g) || (isRemoteHttpUrl(g?.src) ? g.src : "") || "";
        if (!url && !src) continue;
        refs.push({
            url: url || src,
            src: src || url,
            width: g?.width,
            height: g?.height,
            format: typeof g?.format === "number" ? g.format : undefined,
            order: g?.order,
        });
    }
    return refs;
}

function pinKeysForRefs(refs: FavoriteGifRef[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (k: string) => {
        if (!k || seen.has(k)) return;
        seen.add(k);
        out.push(k);
    };
    for (const ref of refs) {
        for (const u of [ref.src, ref.url, pickCacheableUrl(ref)]) {
            if (!u) continue;
            add(cacheKeyForUrl(u));
            for (const k of mediaLookupKeys(u)) add(k);
        }
    }
    return out;
}

function restoreMediaElement(el: HTMLImageElement | HTMLVideoElement) {
    const orig = el.dataset.fgcSrc;
    if (!orig || orig === el.src) return;
    try {
        el.src = orig;
        if (el.tagName === "VIDEO") (el as HTMLVideoElement).load();
    } catch {
    }
}

function onBlobRevoking(blobUrl: string) {
    if (typeof document === "undefined") return;
    try {
        for (const node of document.querySelectorAll("img,video")) {
            const el = node as HTMLImageElement | HTMLVideoElement;
            if (el.src === blobUrl) restoreMediaElement(el);
        }
    } catch {
    }
}

function onPickerMediaError(ev: Event) {
    const el = ev.target as any;
    if (!el || (el.tagName !== "IMG" && el.tagName !== "VIDEO")) return;
    const src = el.currentSrc || el.src;
    if (!src || !String(src).startsWith("blob:")) return;
    restoreMediaElement(el);
}

function maybeSwapMedia(el: HTMLImageElement | HTMLVideoElement) {
    try {
        if (!settings.store.rewriteFavoriteSrc) return;
        const src = el.getAttribute("src") || el.src || "";
        if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
        if (!isRemoteHttpUrl(src) || !isLikelyGifMediaUrl(src)) return;
        if (favoritesSeeded && favoriteUrlSet.size > 0 && !isTrackedFavorite(src)) return;

        const c = cache;
        if (!c?.isInitialized()) return;
        const hit = c.resolveDisplayHitSync(src, { bumpUsage: false });
        if (!hit?.blobUrl?.startsWith("blob:")) return;

        const videoEl = el.tagName === "VIDEO";
        if (videoEl && !isVideoMime(hit.mimeType)) return;
        if (!videoEl && isVideoMime(hit.mimeType)) return;

        if (el.dataset.fgcSrc === src && el.src === hit.blobUrl) return;
        el.dataset.fgcSrc = src;
        el.src = hit.blobUrl;
    } catch {
    }
}

function scanPickerMedia() {
    if (typeof document === "undefined") return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
        scanTimer = null;
        try {
            for (const node of document.querySelectorAll("img[src^=\"http\"],video[src^=\"http\"]")) {
                maybeSwapMedia(node as HTMLImageElement | HTMLVideoElement);
            }
        } catch {
        }
    }, 32);
}

function ensureMediaObserver() {
    if (mediaObserver || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    mediaObserver = new MutationObserver(muts => {
        for (const m of muts) {
            if (m.type === "attributes" && m.target) {
                const t = m.target as any;
                if (t.tagName === "IMG" || t.tagName === "VIDEO") maybeSwapMedia(t);
            }
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                const el = n as Element;
                if (el.tagName === "IMG" || el.tagName === "VIDEO") {
                    maybeSwapMedia(el as any);
                }
                el.querySelectorAll?.("img,video").forEach(child => maybeSwapMedia(child as any));
            }
        }
    });
    mediaObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src"],
    });
}

function bindMediaErrorHealer() {
    if (mediaErrorBound || typeof document === "undefined") return;
    document.addEventListener("error", onPickerMediaError, true);
    mediaErrorBound = true;
}

function unbindMediaErrorHealer() {
    if (!mediaErrorBound || typeof document === "undefined") return;
    document.removeEventListener("error", onPickerMediaError, true);
    mediaErrorBound = false;
    if (mediaObserver) {
        mediaObserver.disconnect();
        mediaObserver = null;
    }
}

function queueWrapWork(
    favorites: any[],
    refs: FavoriteGifRef[],
    visibleKeys: string[],
) {
    wrapWorkPending = { favorites, refs, visibleKeys };
    if (wrapWork) return;
    wrapWork = (async () => {
        try {
            while (wrapWorkPending) {
                const job = wrapWorkPending;
                wrapWorkPending = null;
                await runWrapWork(job);
            }
        } finally {
            wrapWork = null;
        }
    })();
}

async function runWrapWork(job: {
    favorites: any[];
    refs: FavoriteGifRef[];
    visibleKeys: string[];
}) {
    const c = getCache();
    await c.init();
    c.setDisplayPinnedKeys(job.visibleKeys);

    for (const key of job.visibleKeys) {
        if (c.has(key) && !c.hasResidentData(key)) await c.hydrate(key);
        if (c.hasResidentData(key)) c.ensureBlobUrlSync(key, { bumpUsage: false });
    }
    for (const g of job.favorites) applyCacheSrc(g, c);
    scanPickerMedia();

    let downloads = 0;
    for (const ref of job.refs) {
        if (downloads >= 10) break;
        for (const u of [ref.src, ref.url]) {
            if (!u || isAutoCacheDenied(u) || !isLikelyGifMediaUrl(u)) continue;
            const key = cacheKeyForUrl(u);
            if (!c.has(key) && !c.has(u) && downloads < 10) {
                await ensureCached(c, u, { allowEvict: false, ...autoCacheOpts() });
                downloads += 1;
            }
            if (c.has(key) || c.has(u)) {
                await c.ensureBlobUrl(key, { bumpUsage: false });
            }
        }
    }
    for (const g of job.favorites) applyCacheSrc(g, c);
    scanPickerMedia();
}

function toast(message: string, type: any) {
    try {
        Toasts.show({ message, type, id: Toasts.genId() });
    } catch {

    }
}

function resolveItemUrl(item: any): string | null {
    if (!item) return null;
    stashOriginalUrls(item);
    const src = remoteDisplaySrc(item) || undefined;
    const url = remoteSendUrl(item) || undefined;
    const picked = pickCacheableUrl({ src, url, format: item.format });
    if (picked) return picked;
    if (url) return url;
    if (src) return src;
    return null;
}

function isLocallyCached(url: string) {
    try {
        const c = getCache();
        const key = cacheKeyForUrl(url);
        return c.has(key) || c.has(url);
    } catch {
        return false;
    }
}

const autoCacheOpts = () => ({
    isDenied: isAutoCacheDenied,
    maxBytes: perFileMaxBytes(),
});

async function manualCacheGif(url: string) {
    await allowAutoCache(url);
    const c = getCache();
    await c.init();

    const tried = new Set<string>();
    const queue = [url];
    for (const g of lastFavorites) {
        const remotes = remoteCandidates(g);
        if (remotes.some(r => r === url || cacheKeyForUrl(r) === cacheKeyForUrl(url))) {
            for (const r of remotes) queue.push(r);
        }
    }

    for (const u of queue) {
        if (!u || tried.has(u)) continue;
        tried.add(u);
        try {
            const res = await cacheOnUserAction(c, u, fetch, {
                force: true,
                maxBytes: Number.MAX_SAFE_INTEGER,
            });
            if (res?.stored || c.has(cacheKeyForUrl(u)) || c.has(u)) {
                c.ensureBlobUrlSync(cacheKeyForUrl(u), { bumpUsage: true });
                toast("GIF Cached", Toasts.Type.SUCCESS);
                for (const g of lastFavorites) applyCacheSrc(g, c);
                scanPickerMedia();
                return;
            }
        } catch {
        }
    }
    toast("Could not cache GIF", Toasts.Type.FAILURE);
}

async function manualRemoveFromCache(url: string) {
    const c = getCache();
    await c.init();
    const key = cacheKeyForUrl(url);
    await c.delete(key);
    if (key !== url) await c.delete(url);
    await denyAutoCache(url);
    toast("GIF Removed From Cache", Toasts.Type.SUCCESS);
    safeForceUpdate(lastPickerInstance);
}

async function warmCachedFavoriteBlobs() {
    try {
        const c = getCache();
        await c.init();
        let refs = getFavoriteGifRefsFromFrecency();
        if (!refs.length) {
            requestFavoriteGifsLoad();
            refs = getFavoriteGifRefsFromFrecency();
        }
        if (refs.length) refreshFavoriteSet(refs);
        const keys = pinKeysForRefs(refs);
        c.setDisplayPinnedKeys(keys);
        for (const key of keys) {
            if (!c.has(key)) continue;
            try {
                await c.ensureBlobUrl(key, { bumpUsage: false });
            } catch {
            }
        }
        for (const g of lastFavorites) applyCacheSrc(g, c);
        scanPickerMedia();
    } catch {
    }
}

async function prefetchFavorites() {
    try {
        const c = getCache();
        await c.init();
        refreshFavoriteSet();
        let refs = getFavoriteGifRefsFromFrecency();

        if (!refs.length) {
            await new Promise(r => setTimeout(r, 2000));
            refs = getFavoriteGifRefsFromFrecency();
        }

        const targetBytes = prefetchTargetBytes(c.getMaxBytes());
        const newest = sortFavoritesNewestFirst(refs);
        const queue: string[] = [];
        const seen = new Set<string>();
        for (const ref of newest) {
            const u = pickCacheableUrl(ref);
            if (!u) continue;
            const key = cacheKeyForUrl(u);
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push(u);
        }
        if (!queue.length) return;

        const warmNewest = async () => {
            for (const url of queue) {
                try {
                    await c.ensureBlobUrl(cacheKeyForUrl(url), { bumpUsage: false });
                } catch {

                }
            }
        };

        if (c.bytes() >= targetBytes) {
            await warmNewest();
            return;
        }

        let steps = 0;
        for (const url of queue) {
            if (c.bytes() >= targetBytes) break;
            try {
                const key = cacheKeyForUrl(url);
                if (c.has(key) || c.has(url)) continue;
                await ensureCached(c, url, { allowEvict: false, ...autoCacheOpts() });

                steps += 1;
                if (steps % 2 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            } catch {

            }
        }

        await warmNewest();
    } catch {

    }
}

export default definePlugin({
    name: "FavoriteGifCache",
    description: "Caches GIF picker favorites on disk so they load from local storage instead of re-downloading",
    authors: [{ name: "Arad", id: 825757055981846560n }],
    tags: ["GIF", "Media", "Performance"],

    settings,

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: [
                {

                    match: /(,suggestions:\i,favorites:)(\i),/,
                    replace: "$1$self.wrapFavorites(this,$2),",
                },
                {

                    match: /(,suggestions:\i,favorites:)(\i\.getFav\(\i\)),/,
                    replace: "$1$self.wrapFavorites(this,$2),",
                },
            ],
        },
        {
            find: "handleSelectGIF=",
            replacement: {
                match: /handleSelectGIF=(\i)=>\{/,
                replace: "$&$self.onSelectGif($1);",
            },
        },
    ],

    
    gifPickerContextMenu(instance: any, _e?: any) {
        try {
            const item = instance?.props?.item ?? instance?.props;
            const url = resolveItemUrl(item);
            if (!url) return null;

            if (url.startsWith("blob:") || url.startsWith("data:")) return null;

            const cached = isLocallyCached(url);

            return (
                <Menu.MenuGroup>
                    <Menu.MenuItem
                        id="fgc-cache-gif"
                        label="Cache GIF"
                        disabled={cached}
                        action={() => { void manualCacheGif(url); }}
                    />
                    <Menu.MenuItem
                        id="fgc-remove-cache"
                        label="Remove from cache"
                        color="danger"
                        disabled={!cached}
                        action={() => { void manualRemoveFromCache(url); }}
                    />
                </Menu.MenuGroup>
            );
        } catch (e) {
            console.error("[FavoriteGifCache] gifPickerContextMenu failed", e);
            return null;
        }
    },

    
    onSelectGif(gif?: { url?: string; src?: string; format?: number; __fgcOriginalSrc?: string; __fgcOriginalUrl?: string; }) {
        try {
            if (!gif) return;

            restoreUrlsForSend(gif);

            const remote = pickCacheableUrl({
                src: remoteDisplaySrc(gif) || undefined,
                url: remoteSendUrl(gif) || undefined,
                format: gif.format,
            });
            if (!remote) return;
            if (!isTrackedFavorite(remote) && !isTrackedFavorite(remoteSendUrl(gif) || "") && !isTrackedFavorite(remoteDisplaySrc(gif) || "")) {

                if (!isLikelyGifMediaUrl(remote)) return;
            }

            const c = getCache();
            const key = cacheKeyForUrl(remote);
            if (isAutoCacheDenied(remote)) return;

            if (c.has(key) || c.has(remote)) {
                c.touchSync(key) || c.touchSync(remote);
                return;
            }

            void (async () => {
                try {
                    await c.init();
                    await cacheOnUserAction(c, remote, fetch, autoCacheOpts());
                    c.ensureBlobUrlSync(cacheKeyForUrl(remote), { bumpUsage: true });
                } catch {

                }
            })();
        } catch {

        }
    },

    wrapFavorites(instance: any, favorites: any[]) {
        try {
            if (!Array.isArray(favorites)) return favorites;
            if (instance && typeof instance === "object") lastPickerInstance = instance;
            ensureMediaObserver();
            bindMediaErrorHealer();

            if (favorites.length === 0) {
                requestFavoriteGifsLoad();
                refreshFavoriteSet();
                scheduleEmptyRetry(instance);
                return favorites;
            }
            emptyRetryCount = 0;
            lastFavorites = favorites;

            const c = getCache();
            const ready = c.isInitialized() ? c : null;
            for (const g of favorites) applyCacheSrc(g, ready);

            const refs = refsFromFavorites(favorites);
            const { added } = refreshFavoriteSet(refs);
            enqueueFavoriteDiff(added, [], refs);
            const visibleKeys = pinKeysForRefs(refs);
            c.setDisplayPinnedKeys(visibleKeys);
            queueWrapWork(favorites, refs, visibleKeys);
            scanPickerMedia();
            return favorites;
        } catch {
            return favorites;
        }
    },

    async start() {
        try {
            purgeStalePluginSettings();

            try {
                if (settings.store.rewriteFavoriteSrc !== true) {
                    settings.store.rewriteFavoriteSrc = true;
                }
            } catch {

            }
            await loadDenylist();
            await applyLimitsFromSettings();

            try {
                await getCache().init();
            } catch {
            }

            requestFavoriteGifsLoad();
            refreshFavoriteSet();
            hookFavoriteUpdates();
            bindMediaErrorHealer();
            ensureMediaObserver();
            void warmCachedFavoriteBlobs();
            if (favoritePoll) clearInterval(favoritePoll);
            favoritePoll = setInterval(() => {
                try { syncFromFrecency(); } catch { }
            }, 4000);

            const onSettings = () => {
                syncFromFrecency();
            };
            try {
                FluxDispatcher.subscribe("USER_SETTINGS_PROTO_UPDATE", onSettings);
                unsubSettings = () => {
                    try {
                        FluxDispatcher.unsubscribe("USER_SETTINGS_PROTO_UPDATE", onSettings);
                    } catch {
                    }
                };
            } catch {
            }

            if (settings.store.prefetchOnStart) {
                prefetchTimer = setTimeout(() => {
                    void prefetchFavorites().then(() => {
                        scanPickerMedia();
                        setTimeout(() => void prefetchFavorites().then(() => scanPickerMedia()), 8000);
                    });
                }, 800);
            }
        } catch (e) {
            console.error("[FavoriteGifCache] failed to start", e);
        }
    },

    stop() {
        if (prefetchTimer) {
            clearTimeout(prefetchTimer);
            prefetchTimer = null;
        }
        if (scanTimer) {
            clearTimeout(scanTimer);
            scanTimer = null;
        }
        if (emptyRetryTimer) {
            clearTimeout(emptyRetryTimer);
            emptyRetryTimer = null;
        }
        if (unsubSettings) {
            unsubSettings();
            unsubSettings = null;
        }
        if (favoritePoll) {
            clearInterval(favoritePoll);
            favoritePoll = null;
        }
        pendingAddRefs.clear();
        pendingRemoveKeys.clear();
        unbindMediaErrorHealer();
        wrapWorkPending = null;
        cache = null;
        setActiveCache(null);
        favoriteUrlSet = new Set();
        favoritesSeeded = false;
        lastPickerInstance = null;
        lastFavorites = [];
        emptyRetryCount = 0;
    },
});

