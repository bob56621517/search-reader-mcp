import { spawn } from 'node:child_process';
import type { ClientConfig } from './config';

/**
 * client 的 docker 执行边界(ADR-0011)。只做"检测 + 条件满足时静默启动",不做回收。
 * 测试在此边界注入假命令执行器(或经 config.dockerBin 指向假脚本),不触真实 docker。
 */

export interface DockerResult {
  /** 进程退出码;spawn 失败(命令不存在)记 127,超时记 124 */
  code: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunOpts {
  timeoutMs?: number;
  /** 超时时是否 kill 子进程;false 则超时后进程继续后台执行(用于 docker run 拉镜像不中断) */
  killOnTimeout?: boolean;
}

export interface DockerExecutor {
  run(args: string[], opts?: DockerRunOpts): Promise<DockerResult>;
}

export class RealDockerExecutor implements DockerExecutor {
  constructor(private readonly config: ClientConfig) {}

  async run(args: string[], opts: DockerRunOpts = {}): Promise<DockerResult> {
    return new Promise<DockerResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      // Windows 上 docker 常为 .exe/.cmd,需 shell 解析;参数均为内部常量,无外部注入
      const child = spawn(this.config.dockerBin, args, {
        windowsHide: true,
        shell: process.platform === 'win32',
      });
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr });
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          if (opts.killOnTimeout !== false) child.kill();
          finish(124);
        }, opts.timeoutMs);
      }
      child.on('error', (e) => {
        stderr = (e as Error).message;
        finish(127);
      });
      child.on('close', (code) => {
        finish(code ?? 1);
      });
    });
  }
}
