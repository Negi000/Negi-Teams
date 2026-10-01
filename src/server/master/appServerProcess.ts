// Explicit local process boundary for the App Server client. This module is
// not wired to the existing master or worker startup paths. It never retries.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServerClient, type AppServerClientOptions } from "./appServerClient.ts";
import { WindowsProcessTree, type ProcessTreeIdentity, type ProcessTreeReceipt } from "./windowsProcessTree.ts";

export interface AppServerProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stderrLimitBytes?: number;
  client?: AppServerClientOptions;
}
export interface AppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stderrBytes: number;
  treeReceipt?: ProcessTreeReceipt | null;
}

/** The model process does not need the browser's application login secret. */
export function appServerChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !["EBI_AUTH_TOKEN", "NEGI_REVIEW_CONFIG", "NEGI_TASK_CONFIG", "NEGI_KNOWLEDGE_CONFIG", "NEGI_INTEGRATION_CONFIG", "NEGI_TASK_AUTHORING_CONFIG", "NEGI_SETUP_ROOT"].includes(key.toUpperCase())));
}

export class AppServerProcess {
  readonly client: CodexAppServerClient;
  readonly pid: number | null;
  readonly exited: Promise<AppServerExit>;
  readonly treeIdentity: ProcessTreeIdentity | null;
  private stderrTail: Buffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private readonly stderrLimitBytes: number;
  private settled = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams,
                      options: AppServerProcessOptions,private readonly tree?:WindowsProcessTree) {
    this.pid = tree?.identity.rootPid ?? child.pid ?? null;
    this.treeIdentity=tree?.identity??null;
    this.stderrLimitBytes = options.stderrLimitBytes ?? 16_384;
    this.client = new CodexAppServerClient(child.stdout, child.stdin, options.client);
    this.exited = tree ? tree.exited.then(result=>{
      this.settled=true;this.client.close(new Error(result.error??"Contained App Server exited"));
      return {code:result.receipt?.rootCode??result.code,signal:null,error:result.error,stderrBytes:this.stderrBytes,treeReceipt:result.receipt};
    }) : new Promise<AppServerExit>((resolve) => {
      let spawnError: Error | null = null;
      child.on("error", (error) => { spawnError = error; });
      child.on("close", (code, signal) => {
        if (this.settled) return;
        this.settled = true;
        const reason = spawnError ?? new Error(`App Server process exited (code=${code}, signal=${signal})`);
        this.client.close(reason);
        resolve({ code, signal, error: spawnError?.message ?? null,
          stderrBytes: this.stderrBytes });
      });
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.stderrBytes += bytes.length;
      this.stderrTail = this.stderrLimitBytes === 0 ? Buffer.alloc(0) :
        bytes.length >= this.stderrLimitBytes
          ? bytes.subarray(bytes.length - this.stderrLimitBytes)
          : Buffer.concat([this.stderrTail, bytes]).subarray(
            Math.max(0, this.stderrTail.length + bytes.length - this.stderrLimitBytes));
    });
  }

  static launch(options: AppServerProcessOptions): AppServerProcess {
    if (!options.executable || !options.cwd || !Array.isArray(options.args) ||
        options.args.some((arg) => typeof arg !== "string") ||
        (options.stderrLimitBytes !== undefined &&
          (!Number.isSafeInteger(options.stderrLimitBytes) || options.stderrLimitBytes < 0 ||
           options.stderrLimitBytes > 65_536))) {
      throw new Error("App Server process options invalid");
    }
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd, env: appServerChildEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
    });
    try { return new AppServerProcess(child, options); }
    catch (error) { child.kill(); throw error; }
  }

  /** Explicit containment, no fallback. Job membership begins at CreateProcess. */
  static async launchContained(options:AppServerProcessOptions,trustedRoot:string):Promise<AppServerProcess>{
    const tree=await WindowsProcessTree.launch({...options,env:appServerChildEnv(options.env),trustedRoot});
    try{return new AppServerProcess(tree.child,options,tree)}catch(error){await tree.stop();throw error}
  }

  /** Bounded diagnostic only. Never logged automatically. */
  get stderr(): { bytes: number; tail: string } {
    return { bytes: this.stderrBytes, tail: this.stderrTail.toString("utf8") };
  }

  /** Stop only this owned child. No automatic restart or fallback. */
  async stop(graceMs = 3000): Promise<AppServerExit> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 1) throw new Error("stop grace invalid");
    if(this.tree){await this.tree.stop(graceMs);return this.exited}
    if (!this.settled) this.child.kill();
    const timer = setTimeout(() => {
      if (!this.settled) this.child.kill("SIGKILL");
    }, graceMs);
    try { return await this.exited; }
    finally { clearTimeout(timer); }
  }
}
