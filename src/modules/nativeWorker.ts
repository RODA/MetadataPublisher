import { ChildProcess, spawn } from 'child_process';
import * as readline from 'readline';

export class NativeWorkerInitError extends Error {
  public missingPackages: string[];
  constructor(message: string, missingPackages: string[] = []) {
    super(message);
    this.missingPackages = missingPackages;
    Object.setPrototypeOf(this, NativeWorkerInitError.prototype);
  }
}

type NativeWorkerResponse = {
  id?: number;
  type?: string;
  status?: string;
  missing?: string[];
  message?: string;
  result?: unknown;
};

export class NativeRWorker {
  private proc: ChildProcess | null = null;
  private reader: readline.Interface | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: NativeWorkerInitError) => void) | null = null;
  private initialized = false;

  start(rscript: string, _scriptPath: string, libraryDir: string): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.nextId = 1;
    this.pending.clear();
    // Derive the R binary from the Rscript path
    const rbin = rscript.replace(/Rscript(?:\.exe)?$/i, 'R');
    const args = ['--vanilla', '--quiet', '--no-save', '--no-restore', '--slave'];
    this.proc = spawn(rbin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = this.proc!;
    const stdout = proc.stdout!;
    const rl = readline.createInterface({ input: stdout });
    this.reader = rl;
    let stderrBuf = '';
    rl.on('line', (line: string) => this.handleLine(line));
    proc.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString();
      stderrBuf += msg;
      if (/^\s*$/.test(msg)) return;
      console.error('[NativeR stderr]', msg.trim());
    });
    proc.on('exit', () => {
      if (!this.initialized && this.readyReject) {
        this.readyReject(new NativeWorkerInitError('Native R exited before initialization'));
      }
      const err = new Error('Native R session terminated');
      this.rejectAllPending(err);
      this.cleanup();
    });
    proc.on('error', (error: Error) => {
      if (!this.initialized && this.readyReject) {
        this.readyReject(new NativeWorkerInitError(error.message));
      }
      this.rejectAllPending(error);
      this.cleanup();
    });
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = (err: NativeWorkerInitError) => reject(err);
    });
    // Fail fast if init JSON not received in time
    const initTimeout = setTimeout(() => {
      if (!this.initialized && this.readyReject) {
        const err = new NativeWorkerInitError('Native R did not initialize in time');
        this.readyReject(err);
        try { this.stop(); } catch {}
      }
    }, 8000);
    this.readyPromise.finally(() => clearTimeout(initTimeout));
    // Bootstrap R: source dependencies.R which emits a single JSON init line
    const libDirLiteral = JSON.stringify(libraryDir);
    this.proc.stdin?.write(`source(file.path(${libDirLiteral}, "dependencies.R"))` + '\n');
    return this.readyPromise;
  }

  private handleLine(line: string) {
    if (!line) return;
    let payload: NativeWorkerResponse;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    if (!this.initialized && payload.type === 'init') {
      if (payload.status === 'ok') {
        this.initialized = true;
        this.readyResolve?.();
      } else {
        const missingRaw: unknown = (payload as any).missing;
        const missingList: string[] = Array.isArray(missingRaw)
          ? (missingRaw as unknown[]).map(String)
          : (typeof missingRaw === 'string' && missingRaw ? [missingRaw] : []);
        // If we have a concrete missing list, suppress the generic message
        const msg = missingList.length ? '' : (payload.message ?? 'Native R initialization failed');
        const err = new NativeWorkerInitError(msg, missingList);
        this.readyReject?.(err);
        this.stop();
      }
      return;
    }
    if (!this.initialized) return;
    const id = payload.id;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (payload.status === 'ok') {
      pending.resolve(payload.result);
    } else {
      pending.reject(new Error(payload.message || 'Native R error'));
    }
  }

  // Execute a bare R expression, ignore its value
  evalRVoid(expr: string): Promise<void> {
    if (!this.proc || !this.initialized) {
      return Promise.reject(new Error('Native R session is not initialized'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (_v: unknown) => resolve(), reject });
      const wrapped = `try(({ ${expr} ; cat(jsonlite::toJSON(list(id=${id},status=\"ok\"), auto_unbox=TRUE),"\\n") }), silent=TRUE)`;
      const ok = this.proc!.stdin!.write(wrapped + '\n');
      if (!ok) {
        this.pending.delete(id);
        reject(new Error('Failed to send expression to native R'));
      }
    });
  }

  // Execute a bare R expression and return its value serialized by jsonlite
  evalRString(expr: string): Promise<string> {
    if (!this.proc || !this.initialized) {
      return Promise.reject(new Error('Native R session is not initialized'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (res) => resolve(String(res ?? '')), reject });
      const wrapped = `try(({ .mp_res <- ( ${expr} ) ; cat(jsonlite::toJSON(list(id=${id},status=\"ok\",result=.mp_res), auto_unbox=TRUE),"\\n") }), silent=TRUE)`;
      const ok = this.proc!.stdin!.write(wrapped + '\n');
      if (!ok) {
        this.pending.delete(id);
        reject(new Error('Failed to send expression to native R'));
      }
    });
  }

  private buildExpr(action: string, payload?: any): string | null {
    switch (action) {
      case 'load_codebook': {
        const p = String(payload?.path || '');
        return `normalize_codebook(DDIwR::getCodebook(${JSON.stringify(p)}))`;
      }
      case 'ddi_tree_elements':
        return 'ddi_tree_elements()';
      case 'load_dataset': {
        const p = String(payload?.path || '');
        const name = String(payload?.name || 'current');
        return `import_dataset(${JSON.stringify(name)}, ${JSON.stringify(p)})`;
      }
      case 'describe_variable': {
        const ds = String(payload?.dataset || 'current');
        const v = String(payload?.variable || '');
        return `describe_variable(${JSON.stringify(ds)}, ${JSON.stringify(v)})`;
      }
      default:
        return null;
    }
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
    this.rejectAllPending(new Error('Native R session stopped'));
    this.cleanup();
  }

  private rejectAllPending(error: Error) {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  private cleanup() {
    this.proc = null;
    this.initialized = false;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }
  }
}
