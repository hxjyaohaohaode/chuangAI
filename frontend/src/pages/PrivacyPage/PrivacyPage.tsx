/**
 * 隐私政策与用户协议页面（SubTask 28.4 —— AI 内容合规审查）
 *
 * 职责：
 * 1. 公开本系统的数据收集、存储、使用、脱敏机制
 * 2. 声明 AI 生成内容的标识与审核机制
 * 3. 公布用户协议条款
 * 4. 提供联系方式
 *
 * 设计要点（规范第 2、4、5、9、14 章）：
 * - 浅色配色：surface-primary 背景 + surface-secondary 卡片
 * - 零 emoji：全部使用 Phosphor SVG 图标
 * - 无硬边框：区域分隔用 Card 背景色差 + 间距
 * - 流体 clamp：所有字号、间距、最大宽度使用流体 token
 * - WCAG AA：所有文字-背景对比度 ≥ 4.5:1
 * - 内容即设计：纯文本+图标，无装饰性元素
 */

import { useRef } from 'react'
import { Card, GlassCard, Icon, AIBadge, Button, VariableProximity } from '@/components/ui'
import { StreamText } from '@/components/ui/StreamText'
import { useNavigate } from 'react-router-dom'
import './PrivacyPage.css'

/** 章节配置 —— 顺序即展示顺序 */
const SECTIONS: ReadonlyArray<{
    id: string
    icon: 'shield-check' | 'database' | 'eye-slash' | 'lock-key' | 'sparkle' | 'share-network' | 'scale' | 'chat-circle'
    title: string
    paragraphs: ReadonlyArray<string>
    highlights?: ReadonlyArray<{ label: string; value: string }>
}> = [
        {
            id: 'overview',
            icon: 'shield-check',
            title: '一、隐私保护承诺',
            paragraphs: [
                '诗脉·启明 PoeticRealm AI v5.0 是面向小学古诗词教学的教师端竞赛原型。涉及未成年人数据时，部署与使用方仍需依据适用法律、学校制度及所选模型服务商条款完成授权、评估和留痕；本页面不把尚未完成的合规工作表述为既成事实。',
                '当前原则是数据最小化、本地优先、教师复核与可删除。真实模型模式会把完成当前任务所需的最小内容发送给配置的模型服务商，因此系统不作“绝不向第三方传输”的虚假承诺。',
            ],
        },
        {
            id: 'collection',
            icon: 'database',
            title: '二、数据收集说明',
            paragraphs: [
                '当前数据模型会处理班级标识、内部 studentId、脱敏展示名、答题与批改记录、学习行为、朗读音频、上传的答题图片以及 AI 生成结果。竞赛演示数据使用不可还原的演示标识；系统没有学生账号登录功能，也不应把 studentId 描述为登录凭证。',
                'SQLite 数据库、上传文件和缓存默认位于后端本地数据目录；Neo4j 为可选图数据库。真实 AI 模式下，文本、图片或音频会按功能发送至 DeepSeek、MiMo 或阿里云百炼，具体范围取决于教师调用的能力。',
                '长期记忆不是默认采集项：教师必须在设置面板中主动确认脱敏后才可写入。学生记忆绑定服务端会话主体 + classId + studentId，默认 180 天到期；教师偏好默认 365 天到期；两类记忆均支持查看、修改、单条删除和按班级清空。当前版本是单教师本地租户，不等同于校园多租户身份平台。',
            ],
            highlights: [
                { label: '存储位置', value: '本机 SQLite + Neo4j' },
                { label: '默认传输', value: '本机 HTTP / WS' },
                { label: '外部模型传输', value: '真实 AI 模式按需发生' },
                { label: '数据保留', value: '记忆按 TTL；ASR 中间音频 10 分钟；其余需授权治理' },
                { label: '记忆治理', value: '教师显式写入 · 可查看 · 可删除' },
            ],
        },
        {
            id: 'anonymize',
            icon: 'eye-slash',
            title: '三、数据脱敏机制',
            paragraphs: [
                '系统当前实现两层可验证的数据最小化：',
                '存储与课堂广播层：学生记录包含独立 anonymousName，课堂广播从数据库读取该脱敏名，不采信前端提交的姓名；演示库只写入 S01-Li 等不可还原的演示标识。',
                '报告导出层：班级报告导出器使用 anonymousName 与聚合掌握度，不输出真实姓名。公开资源表单不包含学生字段。',
                '长期记忆层：记忆正文拒绝手机号、身份证号、邮箱和访问密钥等直接标识；注入模型前会做 XML 转义、条数/字符预算，并明确标记为不可信参考资料而非系统指令。',
                'K-匿名尚未在当前版本实现，因此系统不声称已达到 k≥5。若需公开真实学情数据，必须在上线前增加 K-匿名/差分隐私处理并完成重识别风险评估。',
            ],
            highlights: [
                { label: '课堂广播', value: '数据库脱敏名' },
                { label: '报告导出', value: '脱敏名 + 聚合数据' },
                { label: '公开资源', value: '不含学生字段' },
                { label: 'K-匿名', value: '尚未实现' },
            ],
        },
        {
            id: 'security',
            icon: 'lock-key',
            title: '四、学生数据安全',
            paragraphs: [
                '当前产品是教师端竞赛原型：Fastify 签发 HMAC HttpOnly 会话，并校验 CSRF、Origin 与 teacherId 边界；浏览器 localStorage 只保存界面缓存，不能替代服务器身份真相。默认 demo 档案不证明现实教师身份；后端默认仅监听 127.0.0.1，Docker DEMO 入口与图数据库限制在本机或内部网络。切换密码或学校统一身份源、启用 TLS 并完成逐资源授权审计前，不得把系统暴露到公网或不受信任局域网。',
                '课堂答题通过 WebSocket 同步时使用数据库中的脱敏名，并忽略前端提交的姓名；数据库仍保存内部 studentId，因此数据库文件与备份必须按教育数据管理。',
                '朗读功能会把音频保存在本地，并在真实模型模式下调用配置的语音识别服务。尚未完成评估的 ASR 中间音频最多保留 10 分钟，过期或超量清理时先删除文件、成功后再删除可追踪元数据；正式评估记录与批改图片仍需由部署方制定期限并人工治理。生成插画、学生音频和批改原图只能由有效教师会话读取，响应禁止共享缓存。采集前应取得授权，并依据所选服务商的数据处理条款完成评估；演示时只使用脱敏测试音频。',
            ],
        },
        {
            id: 'ai-content',
            icon: 'sparkle',
            title: '五、AI 生成内容声明',
            paragraphs: [
                '主要 AI 工作流提供「AI 生成」或置信度提示，但当前版本尚未证明每一个派生页面、导出格式和历史缓存都具有不可遗漏的统一水印。公开提交前必须完成逐界面与逐导出物核验。',
                '批改等关键流程提供教师复核与低置信提示；这不等于所有 AI 产出都已被人工审核。教师在下发、展示或导出前仍需确认事实、教材适配性、价值导向与未成年人适宜性。',
                '系统接入 DeepSeek、MiMo 与阿里云百炼 Wan 系列国产模型。提交给模型的内容应先做最小化与脱敏；是否用于服务商训练取决于实际账号和服务协议，上线前必须逐项核验并留存数据处理条款，不能仅凭代码作出绝对承诺。',
            ],
            highlights: [
                { label: 'AI 模型', value: 'DeepSeek + MiMo + Wan' },
                { label: '模型数据条款', value: '上线前逐项核验' },
                { label: '审核机制', value: '关键流程复核 + 人工责任' },
                { label: '标识状态', value: '主要流程已覆盖，仍需全量核验' },
            ],
        },
        {
            id: 'export',
            icon: 'share-network',
            title: '六、数据导出与分享',
            paragraphs: [
                '教研报告导出设计目标是只使用班级聚合数据与脱敏展示名；公开、分享或提交任何导出物之前，必须再次检查其中是否包含 studentId、原始答题、文件路径或可重识别组合。',
                '开源集市表单当前不设计学生字段，但资源正文仍可能由教师粘贴内容带入学生信息；发布前必须由教师确认并脱敏，不能仅依赖字段结构。',
                '本地下载不会自动形成访问控制或撤回能力。离开本机后的文件由导出者负责加密、保存期限、接收范围与删除。',
            ],
        },
        {
            id: 'terms',
            icon: 'scale',
            title: '七、用户协议',
            paragraphs: [
                '使用本系统即表示同意以下条款：',
                '1. 授权范围：教师在使用本系统过程中上传的教学资源、Prompt 配方、关卡蓝图等内容，授予系统非排他性、可撤销的使用许可，用于教学功能实现与自我进化引擎优化。',
                '2. 知识产权：团队原创代码采用 MIT 协议，第三方组件与字体保留其上游许可；教师原创内容的权利归属以法律和双方约定为准。AI 生成内容的权利状态取决于人的创作性贡献与适用法律，不作一概而论。',
                '3. 责任限制：AI 生成内容仅供参考，教师需对下发学生的所有内容承担最终审核责任。系统不对 AI 生成内容的准确性、完整性作任何明示或暗示担保。',
                '4. 使用边界：本系统仅限小学古诗词教学场景使用，禁止用于商业培训、考试测评机构、学生学情排名等违反教育公平原则的场景。',
                '5. 协议变更：本协议可能根据法律法规或产品迭代更新，重大变更将通过系统通知提前 7 天告知。',
            ],
        },
        {
            id: 'contact',
            icon: 'chat-circle',
            title: '八、联系方式',
            paragraphs: [
                '如对本隐私政策或用户协议有任何疑问、建议或投诉，可通过以下渠道联系：',
                '当前竞赛原型尚未配置可验证的对外隐私联系人、工单系统或响应时限。真实试点前必须补充责任主体、联系方式、请求处理流程与可兑现的响应时限。',
            ],
        },
    ]

/** 最后更新日期 */
const LAST_UPDATED = '2026年8月'

export default function PrivacyPage() {
    const heroSectionCount = SECTIONS.length
    const heroAnonymizeLevels = 2
    const heroCloudUpload = '按需'
    const heroAIModels = 3
    const navigate = useNavigate()

    // spec v7 Phase 6：Hero ref —— VariableProximity 鼠标距离驱动字重变化的容器
    const heroRef = useRef<HTMLDivElement>(null)

    return (
        <div className="pr-privacy-page pr-v5-enter-privacy">
            {/* v5.0 Hero：盾牌矩阵 + 数据控制，左右非对称
             * spec v7 Phase 6：集成 VariableProximity（标题字重跟随鼠标） */}
            <section className="pr-v5-hero pr-v5-hero--privacy" ref={heroRef} aria-label="隐私政策概览">
                <div className="pr-privacy-hero-content">
                    <span className="pr-privacy-hero-eyebrow pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '0ms' }}>
                        <Icon name="shield-check" size={12} weight="bold" />
                        <span>隐私 · 数据边界说明</span>
                    </span>
                    <h1 className="pr-privacy-hero-title pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '80ms' }}>
                        {/* spec v7 Phase 6：VariableProximity 鼠标距离驱动字重变化
                         * 严格移植自《优质前端部件组/7_文本显示粗化.md》 */}
                        <VariableProximity
                            label="隐私与数据边界"
                            fromFontVariationSettings="'wght' 400, 'opsz' 9"
                            toFontVariationSettings="'wght' 700, 'opsz' 40"
                            containerRef={heroRef}
                            radius={140}
                            falloff="gaussian"
                        />
                    </h1>
                    <StreamText
                        content="诗脉·启明 PoeticRealm AI v5.0 竞赛原型。默认本地运行，真实模型模式按需传输；当前能力、限制与上线前责任在此如实说明。"
                        charStagger={20}
                        className="pr-privacy-hero-subtitle"
                    />
                    <div className="pr-privacy-hero-stats pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '240ms' }}>
                        <div className="pr-privacy-hero-stat">
                            <span className="pr-privacy-hero-stat-value">{heroSectionCount}</span>
                            <span className="pr-privacy-hero-stat-label">政策章节</span>
                        </div>
                        <div className="pr-privacy-hero-stat">
                            <span className="pr-privacy-hero-stat-value">{heroAnonymizeLevels}</span>
                            <span className="pr-privacy-hero-stat-label">脱敏层级</span>
                        </div>
                        <div className="pr-privacy-hero-stat">
                            <span className="pr-privacy-hero-stat-value">{heroCloudUpload}</span>
                            <span className="pr-privacy-hero-stat-label">模型外部传输</span>
                        </div>
                        <div className="pr-privacy-hero-stat">
                            <span className="pr-privacy-hero-stat-value">{heroAIModels}</span>
                            <span className="pr-privacy-hero-stat-label">国产模型</span>
                        </div>
                    </div>
                    <p className="pr-privacy-hero-updated pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '320ms' }}>
                        最后更新：{LAST_UPDATED}
                    </p>
                </div>
                {/* 盾牌矩阵：三层防护盾牌 + 数据控制状态指示 */}
                <div className="pr-privacy-hero-shield pr-v5-stagger-item" style={{ ['--v5-stagger-delay' as string]: '200ms' }} aria-hidden="true">
                    <svg viewBox="0 0 240 200" className="pr-privacy-hero-shield-svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
                        <defs>
                            <radialGradient id="pr-privacy-hero-glow" cx="50%" cy="50%" r="50%">
                                <stop offset="0%" stopColor="rgb(var(--c-page-privacy-hero))" stopOpacity="0.24" />
                                <stop offset="70%" stopColor="rgb(var(--c-page-privacy-hero))" stopOpacity="0.06" />
                                <stop offset="100%" stopColor="rgb(var(--c-page-privacy-hero))" stopOpacity="0" />
                            </radialGradient>
                            <linearGradient id="pr-privacy-hero-shield-grad" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stopColor="rgb(var(--c-page-privacy-hero))" stopOpacity="0.35" />
                                <stop offset="100%" stopColor="rgb(var(--c-page-privacy-hero))" stopOpacity="0.12" />
                            </linearGradient>
                        </defs>
                        {/* 中心光晕 */}
                        <circle cx="120" cy="100" r="80" fill="url(#pr-privacy-hero-glow)" />
                        {/* 三层视觉表示边界、最小化与教师复核，不代表三层技术脱敏已实现。 */}
                        {/* 外层：默认本地边界 */}
                        <path d="M 120 30 L 200 55 L 200 110 Q 200 160 120 180 Q 40 160 40 110 L 40 55 Z"
                            fill="url(#pr-privacy-hero-shield-grad)"
                            stroke="rgb(var(--c-accent-primary))"
                            strokeWidth="1.5"
                            strokeOpacity="0.5"
                            className="pr-privacy-hero-shield-outer" />
                        {/* 中层：最小化与脱敏展示 */}
                        <path d="M 120 50 L 180 70 L 180 110 Q 180 145 120 160 Q 60 145 60 110 L 60 70 Z"
                            fill="rgb(var(--c-page-privacy-hero))"
                            fillOpacity="0.18"
                            stroke="rgb(var(--c-accent-info))"
                            strokeWidth="1.5"
                            strokeOpacity="0.6"
                            className="pr-privacy-hero-shield-middle" />
                        {/* 内层：教师复核 */}
                        <path d="M 120 70 L 160 85 L 160 110 Q 160 132 120 145 Q 80 132 80 110 L 80 85 Z"
                            fill="rgb(var(--c-page-privacy-hero))"
                            fillOpacity="0.28"
                            stroke="rgb(var(--c-accent-success))"
                            strokeWidth="2"
                            strokeOpacity="0.8"
                            className="pr-privacy-hero-shield-inner" />
                        {/* 中心锁芯：数据控制核心 */}
                        <g className="pr-privacy-hero-shield-core">
                            <circle cx="120" cy="108" r="14" fill="rgb(var(--c-accent-primary))" fillOpacity="0.9" />
                            <rect x="115" y="105" width="10" height="8" rx="1.5" fill="rgb(var(--c-surface-primary))" />
                            <path d="M 117 105 L 117 101 Q 117 97 120 97 Q 123 97 123 101 L 123 105"
                                stroke="rgb(var(--c-surface-primary))" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                        </g>
                        {/* 底部三状态点：本地优先 / 边界限制 / 人工复核 */}
                        <circle cx="75" cy="190" r="3" fill="rgb(var(--c-accent-success))" className="pr-privacy-hero-dot" />
                        <text x="75" y="198" textAnchor="middle" fontSize="7" fill="rgb(var(--c-text-tertiary))" fontFamily="var(--font-sans)" fontWeight="600">本地</text>
                        <circle cx="120" cy="190" r="3" fill="rgb(var(--c-accent-info))" className="pr-privacy-hero-dot pr-privacy-hero-dot--2" />
                        <text x="120" y="198" textAnchor="middle" fontSize="7" fill="rgb(var(--c-text-tertiary))" fontFamily="var(--font-sans)" fontWeight="600">边界</text>
                        <circle cx="165" cy="190" r="3" fill="rgb(var(--c-accent-success))" className="pr-privacy-hero-dot pr-privacy-hero-dot--3" />
                        <text x="165" y="198" textAnchor="middle" fontSize="7" fill="rgb(var(--c-text-tertiary))" fontFamily="var(--font-sans)" fontWeight="600">复核</text>
                    </svg>
                    <span className="pr-privacy-hero-shield-label">本地边界 · 最小化 · 教师复核</span>
                </div>
            </section>

            {/* 章节 */}
            <div className="pr-privacy-sections">
                {SECTIONS.map((section) => (
                    <Card key={section.id} padding="lg" className="pr-privacy-section">
                        <div className="pr-privacy-section-header">
                            <span className="pr-privacy-section-icon">
                                <Icon name={section.icon} size={18} />
                            </span>
                            <h2 className="pr-privacy-section-title">{section.title}</h2>
                            {section.id === 'ai-content' && <AIBadge size="xs" />}
                        </div>

                        <div className="pr-privacy-section-body">
                            {section.paragraphs.map((p, i) => (
                                <p key={i} className="pr-privacy-paragraph">{p}</p>
                            ))}

                            {section.highlights && (
                                <dl className="pr-privacy-highlights">
                                    {section.highlights.map((h) => (
                                        <div key={h.label} className="pr-privacy-highlight">
                                            <dt className="pr-privacy-highlight-label">{h.label}</dt>
                                            <dd className="pr-privacy-highlight-value">{h.value}</dd>
                                        </div>
                                    ))}
                                </dl>
                            )}
                        </div>
                    </Card>
                ))}
            </div>

            {/* v5.0 Task 5.7：关于本系统 —— 凸显项目愿景与技术架构，让评审看到完整画像 */}
            <GlassCard interactive={false} padding="lg" blur="normal" className="pr-privacy-about">
                <header className="pr-privacy-about-header">
                    <span className="pr-privacy-about-eyebrow">
                        <Icon name="info" size={12} />
                        <span>关于本系统</span>
                    </span>
                    <h2 className="pr-privacy-about-title">诗脉·启明 PoeticRealm AI v5.0</h2>
                    <p className="pr-privacy-about-tagline">
                        面向小学古诗词教学的异构多智能体 Web 应用，融合认知科学、多智能体协作与本地化大模型，让每一首古诗都被深度理解。
                    </p>
                </header>

                <div className="pr-privacy-about-grid">
                    <article className="pr-privacy-about-item">
                        <h3 className="pr-privacy-about-item-title">项目愿景</h3>
                        <p className="pr-privacy-about-item-desc">
                            以"一诗六阶、千人千面"为核心理念，让古诗词教学从"统一背诵"走向"差异化精讲"。通过六阶认知分析挖掘学生隐性缺陷，让每位学生获得专属学习路径。
                        </p>
                    </article>
                    <article className="pr-privacy-about-item">
                        <h3 className="pr-privacy-about-item-title">技术架构</h3>
                        <p className="pr-privacy-about-item-desc">
                            前端 React 18 + Vite 5 + TypeScript 5.6，后端 Fastify 5.10 + better-sqlite3，并可连接 Neo4j。模型适配 DeepSeek 与 MiMo；具体合规性取决于部署地区、账号协议、数据处理配置与学校审批。
                        </p>
                    </article>
                    <article className="pr-privacy-about-item">
                        <h3 className="pr-privacy-about-item-title">适用场景</h3>
                        <p className="pr-privacy-about-item-desc">
                            产品目标覆盖小学 1-6 年级古诗词教师工作流：备课命题、课堂导播、课后批改、学情诊断、创作迭代与教研报告；具体诗目与年级适配须以内容来源核验清单和教师复核为准。当前交付 12 个教师导航模块，不提供独立学生登录或学生自学端。
                        </p>
                    </article>
                    <article className="pr-privacy-about-item">
                        <h3 className="pr-privacy-about-item-title">合规承诺</h3>
                        <p className="pr-privacy-about-item-desc">
                            默认使用本地 SQLite，界面优先展示脱敏标识；AI/DEMO 内容明确标注并保留最小化运行证据。系统提供技术控制但不自动构成法律合规结论，正式使用前仍需完成授权、告知、最小化、留存期限、供应商与学校审批。
                        </p>
                    </article>
                </div>

                <div className="pr-privacy-about-tech">
                    <span className="pr-privacy-about-tech-label">技术栈：</span>
                    <span className="pr-privacy-about-tech-tag">React 18.3</span>
                    <span className="pr-privacy-about-tech-tag">TypeScript 5.6</span>
                    <span className="pr-privacy-about-tech-tag">Vite 5.4</span>
                    <span className="pr-privacy-about-tech-tag">Fastify 5.10</span>
                    <span className="pr-privacy-about-tech-tag">SQLite</span>
                    <span className="pr-privacy-about-tech-tag">Neo4j</span>
                    <span className="pr-privacy-about-tech-tag">deepseek-v4</span>
                    <span className="pr-privacy-about-tech-tag">mimo-v2.5</span>
                </div>
            </GlassCard>

            {/* 页脚 */}
            <footer className="pr-privacy-footer">
                <p className="pr-privacy-footer-text">
                    本文档作为系统隐私保护承诺的唯一权威来源，任何与本系统行为不符的情况视为 Bug，应在下一个迭代中修正。
                </p>
                <div className="pr-privacy-footer-actions">
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="arrow-left" size={14} />}
                        onClick={() => navigate(-1)}
                    >
                        返回上一页
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="graduation" size={14} />}
                        onClick={() => navigate('/dashboard')}
                    >
                        返回教学驾驶舱
                    </Button>
                </div>
            </footer>
        </div>
    )
}
