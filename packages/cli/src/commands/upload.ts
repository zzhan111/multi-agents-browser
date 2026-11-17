/**
 * upload 命令 - 给 <input type=file> 设置本地文件（CDP DOM.setFileInputFiles）
 * 用法：ma-browser upload <ref|selector> <file...> [--force]
 *
 * 目标支持：
 *   - "@5" 或 "5"：snapshot 返回的 ref（file input 本身、其 label 或包含它的容器）
 *   - 其它：CSS 选择器，如 "input[type=file]"（隐藏的 input 没有 ref 时使用）
 * 相对路径按当前目录解析为绝对路径；Windows 绝对路径（C:\...）原样传递。
 */

import path from "node:path";
import { generateId, type Request, type Response } from "@ma-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface UploadOptions {
  json?: boolean;
  tabId?: string | number;
  force?: boolean;
}

/** "@5" / "5" → ref "5"；其余视为 CSS 选择器。 */
export function parseUploadTarget(target: string): { ref: string } | { selector: string } {
  const ref = /^@?(\d+)$/.exec(target.trim());
  return ref ? { ref: ref[1] } : { selector: target };
}

export async function uploadCommand(
  target: string,
  files: string[],
  options: UploadOptions = {}
): Promise<void> {
  if (!target) throw new Error("缺少 ref 或 selector 参数");
  if (files.length === 0) throw new Error("缺少文件路径参数");

  await ensureDaemonRunning();

  const request: Request = {
    id: generateId(),
    action: "upload",
    ...parseUploadTarget(target),
    files: files.map((file) => path.resolve(file)),
    ...(options.force ? { force: true } : {}),
    tabId: options.tabId,
  };

  const response: Response = await sendCommand(request);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else if (response.success) {
    const uploaded = response.data?.uploadedFiles ?? [];
    console.log(`已上传 ${response.data?.files?.length ?? files.length} 个文件到 ${target}`);
    for (const file of uploaded) console.log(`  ${file.name} (${file.size} bytes)`);
    if (uploaded.length === 0) {
      console.log("注意：input.files 为空——自定义上传组件常在 change 后清空 input，请用 snapshot/screenshot 确认页面已显示文件");
    }
  } else {
    console.error(`错误: ${response.error}`);
    process.exit(1);
  }
}
