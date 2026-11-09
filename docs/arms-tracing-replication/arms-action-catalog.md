# 阿里云应用实时监控服务（ARMS）应用监控控制台 动作目录（按资源域）

> 数据源：[`arms-catalog.json`](./arms-catalog.json)（唯一事实源，本文件由 `gen-catalog-doc.mjs` 生成）

## 总览

| 资源域 | 条目数 | observed | derived | unknown | 说明 |
|---|---:|---:|---:|---:|---|
| 应用与配置 | 8 | 4 | 3 | 1 | 应用元信息、模块开关与探针配置 |
| 拓扑与聚合指标 | 7 | 4 | 3 | 0 | 调用链拓扑、慢接口统计、指标聚合 |
| 调用链 Trace | 7 | 4 | 3 | 0 | 链路列表、链路详情、调用栈 |
| 实例与探针 | 6 | 3 | 3 | 0 | 应用实例、探针版本与运行时长 |
| 告警与事件 | 2 | 2 | 0 | 0 | 告警事件列表与链路追踪开关状态 |
| 标签与资源组 | 6 | 1 | 0 | 5 | 实例标签、资源组（多属 ResourceManager / tag 产品） |
| 数据源与 SLS | 8 | 3 | 5 | 0 | SLS 数据源位置、自定义数据源字段 |
| 商业化与配额 | 3 | 2 | 0 | 1 | 商业化状态、SLR、配额 |
| 性能剖析与调试数据 | 12 | 0 | 12 | 0 | Profiling、错误/提取记录、堆转储、热点分析 |
| XTrace（新版链路追踪） | 4 | 0 | 4 | 0 | XTrace 应用与升级 |
| 用户与通用 | 3 | 1 | 2 | 0 | 当前用户、白名单、渠道链接 |
| **合计** | **66** | **24** | **35** | **7** | |

档位含义：**✔ observed** = 真实请求验证过业务成功且拿到数据；**~ derived** = 动作/端点与参数形态来自前端代码或规格，未实测；**? unknown** = 仅确认名称存在，参数形态未知。

## 调用形态（所有条目共用）

```
POST https://fecs.console.aliyun.com/data/api.json
Content-Type: application/x-www-form-urlencoded
Cookie: login_aliyunid_ticket (+ login_aliyunid_sc / login_aliyunid / login_aliyunid_pk / login_current_pk)
Origin: https://armsnext.console.aliyun.com
Referer: https://armsnext.console.aliyun.com/tracing

product=arms&action=<ActionName>&region=<RegionId>&params=<URL编码的 JSON 字符串>
```

批量：`/data/v2/multiApi.json?<Action1>~<Action2>~...`，body `product=arms&actions=[{"action":"...","params":{...}}, ...]`；data 以 "0","1","2" 为键，每项含 success / code / data

成功判定：code === "200"（字符串）；非 200 时 message 给出原因，如 ParameterMissing / ConsoleNeedLogin / InvalidAction.NotFound；二次编码字段：data.Data

## 应用与配置
_应用元信息、模块开关与探针配置_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GetTraceApp` | ✔ observed | read | {"RegionId":"cn-hangzhou","Pid":"<pid>","aliyunLang":"zh"} | TraceApp（AppName / AppId / Pid / Type / Language / ClusterId / ResourceGroupId / Tags） | 查应用元信息；Pid 取自页面 URL 的 appId |
| `ListTraceApps` | ✔ observed | read | {"RegionId":"cn-hangzhou","Page":1,"PageSize":10,"aliyunLang":"zh"} | TraceApps[]（实测该账号 314 个应用） | 分页拉全量应用清单，是「选应用」的入口 |
| `GetModuleConfig` | ✔ observed | read | {"AppType":"trace","RegionId":"cn-hangzhou","Pid":"<pid>","aliyunLang":"zh"} | Data（JSON 字符串：各模块开关，如 cms/cmssae/converge/cmstag/userregion） |  |
| `GetTraceAppConfig` | ✔ observed | read | {"RegionId":"cn-hangzhou","Pid":"<pid>","aliyunLang":"zh"} | Data（JSON 字符串：profiler/agent 开关、excludeurl、callsql 等） |  |
| `SearchTraceAppByName` | ? unknown | read | {"RegionId":"cn-hangzhou"} | 未知 | 实测 ParameterMissing，必填参数名未还原 |
| `GetTraceAppConfigTemplate` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `SaveTraceAppConfig` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou","Pid":"<pid>"} | 未知 |  |
| `SaveTraceAppConfigList` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou","Pid":"<pid>"} | 未知 |  |

## 拓扑与聚合指标
_调用链拓扑、慢接口统计、指标聚合_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GetTraceAggr` | ✔ observed | read | {"RegionId":"cn-hangzhou","Pid":"<pid>","Datasource":"clickhouse","Query":{"startTime":1793887200000,"endTime":1793894400000,"filters":{},"advanced… | Data{topologyMap{nodes[],edges[]}, spanTraceStatInfo[]} | 「应用概览」的核心接口：调用链拓扑 + 慢接口统计。startTime/endTime 为毫秒 |
| `GetTraceGroupBy` | ✔ observed | read | {"RegionId":"cn-hangzhou","Datasource":"clickhouse"} | Data[]（可分组维度：spanName / serviceName / ip / statusCode / attributes.http.status_code / attributes.http.path） |  |
| `GetMetricDatas` | ✔ observed | read | {"RegionId":"cn-hangzhou","Param":{"metric":"OTTRACESTAT.CLICKHOUSE","measures":["count"],"intervalMillis":2147483647,"dimensions":[],"orderBy":"co… | {code:'SUCCESS', data:[{count:N}], dataSource:'SLS'} | 参数名是 Param 不是 Query；metric 在 SLS 数据源下为 OTTRACESTAT.SLS |
| `QueryDashboardForGrafana` | ✔ observed | read | {"Uid":"arms-app-view","RegionId":"cn-hangzhou","Language":"zh"} | Grafana 面板定义 |  |
| `QueryTopology` | ~ derived | read | {"RegionId":"cn-hangzhou","Query":"<JSON 字符串>"} | {nodes[], edges[]} | 端点存在（bundle 中经三参包装调用），实测参数形态未还原 → InternalError |
| `QueryAppMetadata` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `GetPubInfo` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |

## 调用链 Trace
_链路列表、链路详情、调用栈_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GetOTTraceBriefInfos` | ✔ observed | read | {"RegionId":"cn-hangzhou","Datasource":"sls","Query":{"startTime":1793887200000,"endTime":1793894400000,"filters":{},"advancedFilters":[],"page":1,… | Data[]（span 摘要：traceId / spanId / serviceName / spanName / duration / startTime(纳秒) / statusCode） | 调用链列表入口；startTime 为毫秒，span.startTime 为纳秒 |
| `GetTraceChain` | ✔ observed | read | {"RegionId":"cn-hangzhou","TraceId":"<traceId>","Datasource":"sls","StartTime":1793887200000,"EndTime":1793894400000,"FilterComponentNames":[]} | Data{depth, traceChainComplete, roots[], spanNums, componentNames, maxDuration} | 调用链详情；StartTime/EndTime 用毫秒（用纳秒会返回 depth=-1 的空树） |
| `GetOTTraceCallstack` | ✔ observed | read | {"RegionId":"cn-hangzhou","TraceId":"<traceId>","Datasource":"sls","SpanTimestamp":1793887240084961000,"SpanId":"<spanId>","ParentSpanId":null} | Data{depth, roots[], ...}（结构同 GetTraceChain） | 实测可通，但用列表里 span 的时间戳会返回空树；需按 span 自身时间窗口取值 |
| `GetOTTraceCallstackOverview` | ~ derived | read | {"RegionId":"cn-hangzhou","TraceId":"<traceId>","Datasource":"SLS","SpanTimeStamp":1793887240084961000,"SpanId":"<spanId>","ParentSpanId":null} | 调用栈概览（结构待实测） | 注意与 GetOTTraceCallstack 的差别：参数名是 SpanTimeStamp（多一个 T），Datasource 走大写 SLS |
| `GetOTTraceDetails` | ✔ observed | read | {"RegionId":"cn-hangzhou","Datasource":"sls","Query":{"startTime":1793887200000,"endTime":1793894400000,"filters":{},"advancedFilters":[],"page":1,… | Data[] |  |
| `GetTProfInteractionSnapshot` | ~ derived | read | {"RegionId":"cn-hangzhou","Query":{"regionId":"cn-hangzhou","traceId":"<traceId>","startTime":0,"endTime":0}} | data[0] |  |
| `SaveTrace` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou"} | 未知 |  |

## 实例与探针
_应用实例、探针版本与运行时长_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GetAgentInfoByPage` | ✔ observed | read | {"RegionId":"cn-hangzhou","AppName":"<appName>","Page":1,"PageSize":10,"Ip":"","AgentVersion":"","aliyunLang":"zh"} | {Items[], Total, Page, PageSize, OldestAgentVersion, EarliestExpiredAgentInfo} |  |
| `GetAllAgentInfo` | ✔ observed | read | {"RegionId":"cn-hangzhou","AppName":"<appName>","aliyunLang":"zh"} | Items[] |  |
| `ListAppInstances` | ✔ observed | read | {"RegionId":"cn-hangzhou","AppType":"trace","Pid":"<pid>","Page":1,"PageSize":10,"aliyunLang":"zh"} | Items[] | 缺 AppType 会报 MissingAppType |
| `OpenService` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `OpenTelemetry` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `GetATPAccessURL` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |

## 告警与事件
_告警事件列表与链路追踪开关状态_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `ListAlertEvents` | ✔ observed | read | {"RegionId":"cn-hangzhou","Page":1,"Size":5,"Status":"Active","MatchingConditions":[{"key":"_aliyun_arms_involvedObject_id","operator":"eq","value"… | PageBean{Size, Total, Page} |  |
| `GetTraceExplorerStatus` | ✔ observed | read | {"RegionId":"cn-hangzhou","Source":"trace"} | {resourceStatus, status, messages[]} |  |

## 标签与资源组
_实例标签、资源组（多属 ResourceManager / tag 产品）_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `ListArmsInstanceTagResources` | ✔ observed | read | {"RegionId":"cn-hangzhou","ResourceId":"<pid>","ResourceType":"APPLICATION","ExcludeApp":true,"aliyunLang":"zh"} | TagResources[]（TagKey: app / workloadKind，含 HostIp / HostName / ClusterId） |  |
| `GetResourceGroup` | ? unknown | read | {"RegionId":"cn-hangzhou","ResourceGroupId":"<rgId>"} | 无 | product=arms 下 InvalidAction.NotFound；实测该应用所属资源组为 <resourceGroupId> |
| `ListResourceGroups` | ? unknown | read | {"PageNumber":1,"PageSize":10,"Status":"OK"} | 无 | bundle 中经三参包装调用（product 非 arms）→ product=arms 下 InvalidAction.NotFound |
| `ListTagKeys` | ? unknown | read | {"RegionId":"cn-hangzhou"} | 无 | 属 tag / ResourceManager 产品，非 arms |
| `ListTagValues` | ? unknown | read | {"RegionId":"cn-hangzhou"} | 无 | 属 tag / ResourceManager 产品，非 arms |
| `ListTagResources` | ? unknown | read | {"RegionId":"cn-hangzhou","ResourceId":"<pid>","ResourceType":"APPLICATION"} | 无 | 实测 MissingResourceId / MissingResourceType → 归属 product 不对 |

## 数据源与 SLS
_SLS 数据源位置、自定义数据源字段_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `DescribeTraceEndpoint` | ✔ observed | read | {"RegionId":"cn-hangzhou"} | {SlsEndpointDesc{Project, Logstore}, TraceEndpointDesc{PubDomain, VpcDomain, ...}} | SLS 数据源位置；Token/LicenseKey 服务端已打码 |
| `DescribeTraceDataSource` | ✔ observed | read | {"RegionId":"cn-hangzhou","Pid":"<pid>","aliyunLang":"zh"} | 数据源描述 |  |
| `GetUserDatasourceConfig4Sls` | ✔ observed | read | {"RegionId":"cn-hangzhou","StartTime":1793887200000,"EndTime":1793894400000,"Platform":""} | {attributes[], ...} | 自定义数据源（SLS）的字段清单 |
| `DescribeTraceQuality` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `ListUserLogProjects` | ~ derived | read | {"RegionId":"cn-hangzhou"} | LogProjects[] |  |
| `ListUserLogstores` | ~ derived | read | {"RegionId":"cn-hangzhou"} | Logstores[] |  |
| `ListUserLogSavedSearches` | ~ derived | read | {"RegionId":"cn-hangzhou"} | LogSavedSearches[] |  |
| `ListUserLogstoreIndexes` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |

## 商业化与配额
_商业化状态、SLR、配额_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `CheckArmsSLR` | ✔ observed | read | {"RegionId":"cn-hangzhou","Pid":"<pid>","aliyunLang":"zh"} | SLR 状态 |  |
| `GetTraceCommercialStatus` | ✔ observed | read | {"RegionId":"cn-hangzhou","Pid":"<pid>","aliyunLang":"zh"} | CommodityStatus{Status, Lable, FreeDays, EdasBasic, ...} |  |
| `DescribeUserQuota` | ? unknown | read | {"RegionId":"cn-hangzhou"} | 无 | 在 product=arms 下实测 InvalidAction.NotFound —— 属其它 product（ResourceManager 等） |

## 性能剖析与调试数据
_Profiling、错误/提取记录、堆转储、热点分析_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GetProfilingData` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `QueryProfilingData` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `GetCustomErrorRecord` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `GetCustomExtractRecord` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `GetHeapDumpList` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `CreateHeapDump` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `QueryHotSpotData` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `GetBubbleUpBrief` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `GetBubbleUpReport` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `SaveCustomErrorRecord` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `SaveCustomExtractRecord` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `SaveCustomExtractRecordList` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou"} | 未知 |  |

## XTrace（新版链路追踪）
_XTrace 应用与升级_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `UpgradeXTrace` | ~ derived | ⚠ write | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `ListXTraceApps` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `DescribeXTraceApp` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |
| `DescribeXTraceUpgradeStatus` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |

## 用户与通用
_当前用户、白名单、渠道链接_

| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |
|---|---|---|---|---|---|
| `GetUserInfo` | ✔ observed | read | {"RegionId":"cn-hangzhou","aliyunLang":"zh"} | Data{userId} |  |
| `GetChannelLink` | ~ derived | read | {"RegionId":"cn-hangzhou","LinkKey":"arms_commonbuy_arms_xtracegb_post"} | Data.Link |  |
| `GetUserWhiteListStatus` | ~ derived | read | {"RegionId":"cn-hangzhou"} | 未知 |  |

## 明确排除（不在本次复刻范围）

| 主机 / 接口族 | 排除原因 |
|---|---|
| armsnext.console.aliyun.com<br>`ResourceCenter__GetResourceCenterServiceStatus`, `ResourceCenter__ListResourceTypes+GetResourceCounts`, `one-console-app-home__GetConsoleByCommodity` | 需要 collina=140#... 反爬签名（页面内 uab/collina.js 计算），无 UI 模式下不可离线复现 |
| fecs.console.aliyun.com<br>`notifications__ReadMessageList`, `notifications__ReadNotifications`, `Workorder__RecognizeCustomerType`, `occa-myalicloud__GetUserRecentProductList` | 同上，需要 collina 签名；属控制台壳功能，非 ARMS 业务数据 |

