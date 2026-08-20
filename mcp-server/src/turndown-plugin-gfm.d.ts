// 临时声明：turndown-plugin-gfm 未自带类型定义。
// 它导出一组 TurndownService 插件（Plugin = (service) => void）。
declare module "turndown-plugin-gfm" {
  import TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}
