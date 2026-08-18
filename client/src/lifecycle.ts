import type { ClientConfig } from './config';
import type { DockerExecutor, DockerResult } from './docker';
import type { ServerHttp } from './server-http';

/**
 * 容器生命周期状态机(ADR-0011)。
 * client 不把容器当临时子进程,而是当常驻基础设施,只做"检测 + 条件满足时静默启动",不做回收。
 *
 * 状态流转:
 *   starting(初始/窗口期)→ ready(health 命中)→ down(曾 ready 后 health 失败,不自动重启)
 *   starting 超过 startupWindowMs 仍未健康 → down(容器首次拉起即崩溃的兜底)
 *
 * ensureStarted 返回失败(缺 docker / 缺 REQUIRED_ENVS / docker run 失败)时,main 按
 * 正常 MCP 失败路径 stderr 报错并退出,工具不注册。
 */

export type ServerStatus = 'starting' | 'ready' | 'down';

export interface Lifecycle {
  /** 工具 handler 查询容器可用状态 */
  status(): ServerStatus;
  /**
   * 启动流程:health 命中 → ready;否则条件齐备 → 后台 docker run(容错 name in use →
   * docker start),进入 starting 并启动后台轮询;缺前置 → 返回失败原因。
   */
  ensureStarted(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 停止后台轮询(测试用;生产 client 常驻至进程退出) */
  stop(): void;
}

export function createLifecycle(
  config: ClientConfig,
  http: ServerHttp,
  docker: DockerExecutor,
): Lifecycle {
  let state: ServerStatus = 'starting';
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const isNameInUse = (stderr: string): boolean =>
    /(name is in use|already in use|container name.*exists|the container name)/i.test(stderr);

  /** docker run 命令(ADR-0011):常驻 --restart unless-stopped,卷透传 BOCHA_API_KEY */
  const runContainer = (): Promise<DockerResult> =>
    docker.run(
      [
        'run',
        '-d',
        '--name',
        config.containerName,
        '--restart',
        'unless-stopped',
        '-p',
        `${config.hostPort}:18081`,
        '-e',
        'BOCHA_API_KEY',
        '-v',
        `${config.dataVolume}:/app/extension/data`,
        config.image,
      ],
      { timeoutMs: config.dockerRunTimeoutMs, killOnTimeout: false },
    );

  const startPolling = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      void (async () => {
        const alive = await http.health();
        if (alive) {
          state = 'ready';
          return;
        }
        if (state === 'ready') {
          state = 'down';
          return;
        }
        // starting:启动窗口内保持"正在启动";超窗口视为容器不可用
        if (startedAt > 0 && Date.now() - startedAt > config.startupWindowMs) {
          state = 'down';
        }
      })().catch((e) => {
        // 轮询异常(打桩实现抛错/探测异常)忽略,下轮重试;RealServerHttp.health 内部已吞异常
        console.error('[search-reader-mcp-client] 健康轮询异常:', (e as Error).message);
      });
    }, config.healthPollIntervalMs);
  };

  return {
    status(): ServerStatus {
      return state;
    },

    async ensureStarted(): Promise<{ ok: true } | { ok: false; reason: string }> {
      // ① health 命中 → 复用,静默 ready
      if (await http.health()) {
        state = 'ready';
        startPolling();
        return { ok: true };
      }
      // ② docker 可用性
      const info = await docker.run(['info'], { timeoutMs: 10000 });
      if (info.code !== 0) {
        return { ok: false, reason: `docker 不可用(docker info 退出码 ${info.code}):${info.stderr || '请确认 docker 已安装并启动'}` };
      }
      // ③ REQUIRED_ENVS 齐备(可扩展列表,ADR-0011)
      const missing = config.requiredEnvs.filter((name) => !process.env[name]?.trim());
      if (missing.length > 0) {
        return { ok: false, reason: `缺少必填环境变量: ${missing.join(', ')}` };
      }
      // ④ 后台 docker run(拉镜像超时转为后台观察,不阻塞 client 启动)
      const run = await runContainer();
      if (run.code !== 0) {
        // 容错:容器已存在 → docker start(常驻复用)
        if (isNameInUse(run.stderr)) {
          const start = await docker.run(['start', config.containerName], { timeoutMs: 30000 });
          if (start.code !== 0) {
            return { ok: false, reason: `docker start 失败(退出码 ${start.code}):${start.stderr}` };
          }
        } else if (run.code === 124) {
          // docker run 超时仍在拉取镜像:转为后台观察,容器 daemon 会自行完成
          // (ADR-0011 窗口期:工具返回"容器正在启动")
        } else {
          return { ok: false, reason: `docker run 失败(退出码 ${run.code}):${run.stderr}` };
        }
      }
      state = 'starting';
      startedAt = Date.now();
      startPolling();
      return { ok: true };
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
