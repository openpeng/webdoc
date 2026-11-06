# 高顿 Confluence 知识库 动作目录（按资源域）

> 数据源：[`confluence-catalog.json`](./confluence-catalog.json)（唯一事实源，本文件由 `gen-catalog-doc.mjs` 生成）

## 总览

| 资源域 | 条目数 | observed | derived | unknown | 说明 |
|---|---:|---:|---:|---:|---|
| 编辑器、宏与创建对话框 | 36 | 0 | 36 | 0 | 编辑器加载、宏浏览器、创建对话框、高亮面板与路线图 |
| 附件与文件资源 | 14 | 0 | 14 | 0 | 附件上传、拖拽上传、文档转换、头像与空间设置 |
| 管理、运维与实例状态 | 15 | 0 | 15 | 0 | 管理后台、实例状态、许可横幅与功能发现 |
| 集成与第三方连接 | 29 | 1 | 28 | 0 | 应用链接（App Links）、Jira 集成、宏应用与 Gadget |
| 交互与个人状态 | 29 | 0 | 29 | 0 | 收藏、关注、通知数、快捷方式、菜单、权限与个人资料 |
| 空间与导航 | 10 | 0 | 10 | 0 | 空间列表、页面树、面包屑、链接面板与空间可用性 |
| 评论与任务 | 5 | 0 | 5 | 0 | 行内评论、任务面板与草稿删除 |
| 协作同步（Synchrony） | 6 | 0 | 6 | 0 | 实时协作通道、同步代理与内容同步 |
| 页面路由（非 REST，仅作重定向证据） | 1 | 0 | 1 | 0 | 页面级路由：实测会被服务端 302 重定向，不能当 API 用 |
| 页面与内容 | 31 | 0 | 31 | 0 | 页面正文、CQL 查询、内容原型、草稿与附件搜索 |
| 账号与组织 | 6 | 0 | 6 | 0 | 用户、邀请、目录与第三方账号 |
| **合计** | **182** | **1** | **181** | **0** | |

档位含义：**✔ observed** = 真实请求验证过业务成功且拿到数据；**~ derived** = 动作/端点与参数形态来自前端代码或规格，未实测；**? unknown** = 仅确认名称存在，参数形态未知。

## 调用形态（所有条目共用）

```
GET/POST/PUT（按条目） https://confluence.gaodunwangxiao.com/confluence/<条目路径>
Content-Type: application/json（POST/PUT）；GET 无请求体
Cookie: JSESSIONID

query 参数进 URL；path 参数按 {name} 占位替换；body 参数按参数 location 决定进 query 还是 body
```

成功判定：HTTP 2xx（不是 body.code）

## 编辑器、宏与创建对话框
_编辑器加载、宏浏览器、创建对话框、高亮面板与路线图_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/includes/soy/breadcrumbs.soy` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/includes/soy/dialog.soy` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/includes/soy/dom-filter-field.soy` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/includes/soy/manage-watchers.soy` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/includes/soy/user.soy` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/plugins/editor-loader/editor.action` | ~ derived | read | {"atl_after_login_redirect":"/confluence/pages/viewpage.action","pageid":"651362413","parentpageid":"22891395","spacekey":"GAOD","timeout":"12000"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/plugins/editor/tinymce` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/plugins/macrobrowser/browse-macros-details.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/plugins/macrobrowser/browse-macros.action` | ~ derived | read | {"detailed":"false","macrometadataclientcachekey":"1793892789671"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/plugins/roadmap/create-page.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/tinymce/helplink.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/create-dialog/1.0` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/create-dialog/1.0/blueprints/can-create-page` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/create-dialog/1.0/blueprints/web-items` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/create-dialog/1.0/space-blueprint/create-personal-space` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/create-dialog/1.0/space-blueprint/dialog/web-items` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/create-dialog/1.0/spaces` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/create-dialog/1.0/spaces/skip-space-welcome-dialog` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/create-dialog/1.0/storage/quick-create` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `PUT /confluence/rest/create-dialog/1.0/storage/quick-create` | ~ derived | ⚠ write | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/emoticons/1.0` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/rest/highlighting/1.0/insert-storage-column-table` | ~ derived | ⚠ write | {"contenttype":"<contenttype>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/rest/highlighting/1.0/insert-storage-fragment` | ~ derived | ⚠ write | {"contenttype":"<contenttype>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/highlighting/1.0/panel-items` | ~ derived | read | {"pageid":"651362413"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/rest/roadmap/1.0/bar` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/roadmap/1.0/extractPageLinks` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/tinymce/{id}/content` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/tinymce/{id}/drafts` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/tinymce/{id}/drafts/discard` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/tinymce/{id}/drafts/message` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/tinymce/{id}/embed/placeholder/image` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/tinymce/{id}/macro/definition` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/tinymce/{id}/macro/placeholder` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/tinymce/{id}/macro/preview` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/tinymce/{id}/markdownxhtmlconverter` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/tinymce/{id}/wikixhtmlconverter` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |

## 附件与文件资源
_附件上传、拖拽上传、文档转换、头像与空间设置_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/plugins/drag-and-drop/upload.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 实测 HTTP 403：403 鉴权拦截，端点存在。 |
| `GET /confluence/rest/autoconvert/1.0/cloudappembed` | ~ derived | read | {"resource":"<resource>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/autoconvert/1.0/skitchembed` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/autoconvert/latest/shortcutlinkconfigurations` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/documentConversion/latest` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/documentConversion/latest/conversion/thumbnail` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/rest/documentConversion/latest/conversion/thumbnail/results` | ~ derived | ⚠ write | {"contenttype":"<contenttype>","id":"<id>","v":"<v>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/rest/drag-and-drop/{id}/tip/disable` | ~ derived | ⚠ write | {"id":"<id>","contenttype":"<contenttype>","datatype":"<datatype>","success":"<success>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/drag-and-drop/{id}/tip/setting` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/files/1.0/files/content/_0_/commentCount` | ~ derived | read | {"attachmentid":"<attachmentid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `POST /confluence/rest/ia/1.0/space/option` | ~ derived | ⚠ write | {"contenttype":"<contenttype>","datatype":"<datatype>","option":"<option>","spacekey":"<spacekey>","success":"<success>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/ia/1.0/space/setLogo` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `POST /confluence/rest/webResources/1.0/resources` | ~ derived | ⚠ write | {"c":"<c>","r":"<r>","xc":"<xc>","xr":"<xr>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/servlet/view-file-macro/placeholder` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |

## 管理、运维与实例状态
_管理后台、实例状态、许可横幅与功能发现_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/admin/billing/addapplication` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `PUT /confluence/admin/billing/addapplication` | ~ derived | ⚠ write | {"product":"<product>","contenttype":"<contenttype>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/admin/usermacros.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/request/edit` | ~ derived | ⚠ write | {"contenttype":"<contenttype>","success":"<success>","title":"<title>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `POST /confluence/rest/feature-discovery/1.0/discovered` | ~ derived | ⚠ write | {"featurekey":"<featurekey>","listdiscovered":"<listdiscovered>","pluginkey":"<pluginkey>","success":"<success>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/rest/licensebanner/1.0/reminder/later` | ~ derived | ⚠ write | {"contenttype":"<contenttype>","datatype":"<datatype>","remindmenever":"<remindmenever>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/licensebanner/1.0/reminder/never` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/menu/latest/admin` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/quickreload/latest` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/ui/1.0` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/ui/1.0/content` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/secure/admin/EditApplicationProperties` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/secure/admin/ViewApplicationProperties` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/status` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径（实测 404）；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 实测 HTTP 404：裸形态 404。 |
| `GET /confluence/type/entity` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |

## 集成与第三方连接
_应用链接（App Links）、Jira 集成、宏应用与 Gadget_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/plugins/servlet/applinks/listApplicationLinks` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/applinks/listEntityLinks` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/applinks/proxy` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/plugins/servlet/confluence/placeholder/template-variable` | ~ derived | read | {"name":"<name>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/plugins/servlet/confluence/placeholder/unknown-attachment` | ✔ observed | read | — | 二进制响应（Content-Type: image/png） |  |
| `GET /confluence/plugins/servlet/custom-content-links-admin` | ~ derived | read | {"entitykey":"<entitykey>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/customize-application-navigator` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/hipchat/configure` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/issue-retriever` | ~ derived | read | {"appid":"<appid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/jira-integration/icons` | ~ derived | read | {"2":"<2>","icontype":"<icontype>","serverid":"<serverid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/jira-metadata/redirect` | ~ derived | read | {"u":"<u>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/notifications-miniview` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/plugins/servlet/oc/getattachment` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/plugins/servlet/twoDimensionalShowMoreRenderer` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/servlet/upm/marketplace/featured` | ~ derived | read | {"category":"<category>","source":"<source>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/applinks` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/applinks-oauth` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/applinks-oauth/1.0` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/applinks/1.0` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/com.atlassian.confluence.contributors/1.0/contributors` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/gadget/1.0/statTypes` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/hipchat/integration/1.0/users` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/jira-integration/1.0/issues` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/jira-integration/1.0/servers` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/jira-integration/latest/fields/autocomplete` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/jira-metadata/1.0/metadata` | ~ derived | read | {"pageid":"<pageid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/jira-metadata/1.0/metadata/aggregate` | ~ derived | read | {"pageid":"<pageid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/jiraanywhere/1.0/jira/appLink` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/jiraanywhere/1.0/servers` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |

## 交互与个人状态
_收藏、关注、通知数、快捷方式、菜单、权限与个人资料_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/json/deletedraft.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/json/listwatchers.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/json/removewatch.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/json/startheartbeatactivity.action` | ~ derived | ⚠ write | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/json/stopheartbeatactivity.action` | ~ derived | ⚠ write | {"request":"<request>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/rest/access/latest/page/restriction` | ~ derived | ⚠ write | {"contenttype":"<contenttype>","success":"<success>","title":"<title>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/access/latest/page/restriction` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/confluenceshortcuts/latest/enabled` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/experimental/relation/user` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `PUT /confluence/rest/experimental/relation/user` | ~ derived | ⚠ write | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/experimental/relation/user/current/favourite/toContent` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/experimental/relation/user/current/favourite/toSpace` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/helptips/1.0/tips` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实请求 200 且 Content-Type=application/json，但响应体为空/未采样，按证据判据不计 observed。 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/rest/likes/1.0/content` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/likes/1.0/content/{id}/likes` | ~ derived | read | {"id":"<id>","commentlikes":"true"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/rest/likes/1.0/user` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/menu/latest/appswitcher` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `PUT /confluence/rest/menu/latest/userdata` | ~ derived | ⚠ write | {"contenttype":"<contenttype>","dropdowncontents":"<dropdowncontents>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/mywork/latest/status/notification/count` | ~ derived | read | {"pageid":"651362413"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实请求 200 且 Content-Type=application/json，但响应体为空/未采样，按证据判据不计 observed。 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/rest/project-shortcuts/1.0/local` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/project-shortcuts/1.0/remote` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/quicknav/{id}/search` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/recentlyviewed/1.0/recent` | ~ derived | read | {"includetrashedcontent":"<includetrashedcontent>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/recentlyviewed/1.0/recent/pages` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/recentlyviewed/1.0/recent/spaces` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/shortcuts/latest/shortcuts` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/shortcuts/latest/shortcuts/{id}/{id_2}` | ~ derived | read | {"id":"<id>","id_2":"<id_2>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/rest/watch-button/1.0/watchState` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/watch-button/1.0/watchState/{id}` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |

## 空间与导航
_空间列表、页面树、面包屑、链接面板与空间可用性_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/ajax/spaceavailable.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/pages/breadcrumb.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/plugins/pagetree/naturalchildren.action` | ~ derived | read | {"ancestors":"<ancestors>","decorator":"none","disablelinks":"false","excerpt":"false","expandcurrent":"true","hasroot":"false","mobile":"false","r… | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /confluence/rest/ia/1.0/link` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/ia/1.0/link/advanced` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/ia/1.0/link/main` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径（实测 404）；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 实测 HTTP 404：裸形态 404。 |
| `GET /confluence/rest/ia/1.0/link/quick` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/ia/1.0/pagetree/blog/subtree` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/ia/1.0/space/childPagesContextualNav` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/ia/1.0/spacesmenu` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |

## 评论与任务
_行内评论、任务面板与草稿删除_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/plugins/inlinetasks/mytasks.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/inlinecomments/1.0/comments` | ~ derived | read | {"containerid":"651362413"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 实测 HTTP 404：带前缀仍 404，参数形态存疑。 |
| `GET /confluence/rest/inlinecomments/1.0/comments/replies` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/inlinetasks/{id}/task` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/inlinetasks/{id}/task-report` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |

## 协作同步（Synchrony）
_实时协作通道、同步代理与内容同步_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `DELETE /confluence/rest/synchrony/1.0/content` | ~ derived | ⚠ write | {"draftid":"<draftid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `PUT /confluence/rest/synchrony/1.0/content` | ~ derived | ⚠ write | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/synchrony/1.0/token` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/synchrony-proxy/heartbeat` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `POST /confluence/synchrony-proxy/v1/data/{id}/{id_2}` | ~ derived | ⚠ write | {"id":"<id>","id_2":"<id_2>","cached":"true","rewrite_request":"true","state_at":"@head","state_format":"type-tagged","headers_content_type":"appli… | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |
| `GET /synchrony/heartbeat` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 真实抓包观测到该端点被调用（端点与参数形态已观测，响应体未采样）。 |

## 页面路由（非 REST，仅作重定向证据）
_页面级路由：实测会被服务端 302 重定向，不能当 API 用_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/pages` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 实测 HTTP 302：服务端重定向；本仓按 fail-closed 不跟随。 |

## 页面与内容
_页面正文、CQL 查询、内容原型、草稿与附件搜索_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/download/resources` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径（实测 404）；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 实测 HTTP 404：裸形态 404。 |
| `GET /confluence/download/resources/com.atlassian.plugins.editor/tinymcesource` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/json/attachmentsearch.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/json/contentnamesearch.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径（实测 404）；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 实测 HTTP 404：裸形态 404。 |
| `GET /confluence/json/draftattachmentsearch.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `POST /confluence/json/pagechildren.action` | ~ derived | ⚠ write | {"error":"<error>","pageid":"<pageid>","showchildren":"<showchildren>","success":"<success>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `POST /confluence/json/pagechildrenstoresettings.action` | ~ derived | ⚠ write | {"error":"<error>","pageid":"<pageid>","setting":"<setting>","showchildren":"<showchildren>","success":"<success>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/pages/createblogpost.action` | ~ derived | read | {"spacekey":"<spacekey>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/pages/createpage-entervariables.action` | ~ derived | read | {"templateid":"<templateid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/pages/createpage.action` | ~ derived | read | {"spacekey":"<spacekey>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/pages/doaddcomment.action` | ~ derived | read | {"pageid":"<pageid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/pages/doeditcomment.action` | ~ derived | read | {"pageid":"<pageid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/pages/rendercontent.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/pages/resumedraft.action` | ~ derived | read | {"draftid":"<draftid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/pages/viewpage.action` | ~ derived | read | {"pageid":"<pageid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/api/{id}/field` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/api/content` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `DELETE /confluence/rest/api/content` | ~ derived | ⚠ write | {"contenttype":"<contenttype>","datatype":"<datatype>","draftid":"<draftid>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/api/search` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/api/space` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/api/user/watch/content` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/api/user/watch/space` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/cql/contenttypes` | ~ derived | read | {"category":"<category>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/cql/expressions` | ~ derived | read | {"cql":"<cql>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/cql/fields` | ~ derived | read | {"filter":"<filter>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/prototype/{id}` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/prototype/{id}/content` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/prototype/{id}/i18n` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/prototype/{id}/search/user` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/prototype/{id}/space` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |
| `GET /confluence/rest/prototype/{id}/user/non-system` | ~ derived | read | {"id":"<id>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |

## 账号与组织
_用户、邀请、目录与第三方账号_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GET /confluence/rest/easyuser/latest/refreshToken` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/easyuser/latest/sendEmailOnInvite` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/easyuser/latest/sendUserInvites` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `POST /confluence/rest/easyuser/latest/signup/setSignupSettings` | ~ derived | ⚠ write | {"contenttype":"<contenttype>","datatype":"<datatype>","processdata":"<processdata>","success":"<success>"} | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/rest/easyuser/latest/undoTokenReset` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） | 原始形态为裸路径；规范形态由同批 A/B 对照推得（同相对路径带前缀形态实测 200/403/302），本条带前缀形态未逐条实测。 |
| `GET /confluence/users/profile/editmyprofilepicture.action` | ~ derived | read | — | 返回结构未采样（capture 通道未取到响应体，字段未知） |  |

## 明确排除（不在本次复刻范围）

| 主机 / 接口族 | 排除原因 |
|---|---|
| confluence.gaodunwangxiao.com<br>`GET /a/i`, `GET /a/b`, `GET /images/icons/emoticons`, `GET /confluence/display/~`, `GET /confluence/s/zh_CN/{id}/{id_2}/_`, `GET /v1`, `GET /download`, `GET /confluence/wiki/contactadministrators.action`, `GET /data` | 噪音路径 / 非 API 路由（扫描阶段未被噪音过滤拦下，本目录人工剔除） |
| confluence.gaodunwangxiao.com<br>`POST /rest/webResources/1.0/resources`, `GET /json/removewatch.action`, `GET /json/listwatchers.action`, `POST /json/pagechildrenstoresettings.action`, `POST /json/pagechildren.action`, `GET /rest/prototype/{id}/i18n`, `GET /rest/experimental/relation/user/current/favourite/toContent`, `GET /pages/breadcrumb.action`, `GET /pages/createpage.action`, `GET /rest/create-dialog/1.0/storage/quick-create`, `PUT /rest/create-dialog/1.0/storage/quick-create`, `GET /rest/create-dialog/1.0/spaces`, `GET /rest/create-dialog/1.0/blueprints/can-create-page`, `GET /pages/createpage-entervariables.action`, `GET /rest/create-dialog/1.0/spaces/skip-space-welcome-dialog`, `GET /ajax/spaceavailable.action`, `GET /rest/shortcuts/latest/shortcuts`, `GET /rest/confluenceshortcuts/latest/enabled`, `GET /plugins/servlet/hipchat/configure`, `GET /rest/hipchat/integration/1.0/users`, `GET /rest/mywork/latest/status/notification/count`, `GET /plugins/macrobrowser/browse-macros.action`, `GET /plugins/drag-and-drop/upload.action`, `GET /plugins/servlet/confluence/placeholder/unknown-attachment`, `GET /pages`, `GET /rest/quicknav/{id}/search` | 同相对路径的裸形态重复条目（实测 404）与重复条目，已由带前缀的规范形态取代 |
| confluence.gaodunwangxiao.com<br>`静态资源（.js/.css/.png/.map）` | 扫描阶段按 includeStaticAssets=false 丢弃（本次跳过 24 个静态资源端点） |
| confluence.gaodunwangxiao.com<br>`埋点 / 监控类端点` | 扫描阶段已忽略 1 个埋点端点，非业务数据 |

## 实测样例

| 条目 | 方法 | 路径 | HTTP | 结论 |
|---|---|---|---:|---|
| `get-plugins-drag-and-drop-upload-action` | GET | `/confluence/plugins/drag-and-drop/upload.action` | 403 | 403 鉴权拦截，端点存在 |
| `get-status` | GET | `/confluence/status` | 404 | 裸形态 404 |
| `get-plugins-servlet-confluence-placeholder-unknown-attachment` | GET | `/confluence/plugins/servlet/confluence/placeholder/unknown-attachment` | 200 | 拿到二进制 PNG 响应体 |
| `get-rest-helptips-1-0-tips` | GET | `/confluence/rest/helptips/1.0/tips` | 200 | 200 但响应体为空数组，不计 observed |
| `get-rest-mywork-latest-status-notification-count` | GET | `/confluence/rest/mywork/latest/status/notification/count` | 200 | 200 但响应体为空/未采样，不计 observed |
| `get-rest-ia-1-0-link-main` | GET | `/confluence/rest/ia/1.0/link/main` | 404 | 裸形态 404 |
| `get-rest-inlinecomments-1-0-comments` | GET | `/confluence/rest/inlinecomments/1.0/comments` | 404 | 带前缀仍 404，参数形态存疑 |
| `get-pages` | GET | `/confluence/pages` | 302 | 服务端重定向；本仓按 fail-closed 不跟随 |
| `get-download-resources` | GET | `/confluence/download/resources` | 404 | 裸形态 404 |
| `get-json-contentnamesearch-action` | GET | `/confluence/json/contentnamesearch.action` | 404 | 裸形态 404 |

## 已知坑

| 坑 | 影响 | 规避 |
|---|---|---|
| 业务路径必须带应用上下文前缀 /confluence | 裸形态实测 8/8 全部 HTTP 404（/pages、/status、/v1、/download/resources、/rest/ia/1.0/link/main、/json/contentnamesearch.action、/plugins/servlet/confluence/placeholder/unknown-attachment、/plugins/drag-and-drop/upload.action） | 目录内所有条目一律用带前缀形态；带前缀的同相对路径实测为 200 / 403 / 302，无 404 |
| 会话 cookie JSESSIONID 的 path 是 /confluence | 裸路径请求根本不会带上会话 cookie，登录态判定失真 | 只请求 /confluence 前缀下的路径 |
| 服务端重定向被 fail-closed 阻断 | GET /confluence/pages 实测 302，被记为失败而非「可用」，污染端点可用性判断 | 用具体 REST 端点替代页面路由；302 不等于端点不可用 |
| capture 通道未采到响应体 | captureResponseBody=true 时 sampledResponseCount 仍为 0，响应结构一维全部 unknown | 需要响应结构时人工抓一次 HAR/SAZ 归档再入目录 |
| merge 模式会用无响应体的新批次覆盖已有 observed 证据 | 实测 6 条 observed（含 responseFields）被 14 条无响应体的重捕获清空，tier 全域退化为 unknown | 重捕获前先备份缓存目录；或人工复核后用 update_api_command 标 manuallyEdited 保住 |
| 同一路径两种形态并存导致命令数虚增 | 实测缓存 217 条命令中 27 条是同相对路径的裸形态重复项（commandId 按 pathTemplate 哈希，形态不同即不合并） | 按相对路径归一后再比较端点数；本目录已归一为 181 条 + 27 条被取代 |
| 噪音路径过滤有漏网 | /a/b、/a/i、/v1、/data、/images/**、/s/zh_CN/** 等 10 条噪音条目进入了命令集 | 本目录已人工剔除并列进 excluded；扫描侧需扩 isNoisePath() 的判定面 |
| 写操作全部未实测 | 本目录含 write 条目但无一条取得业务成功样本，body 编码与副作用未知 | 客户端默认拒写，需显式 --confirm-write；上线前先在测试空间验证 |

