#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argValue = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
}
const auditRoot = path.resolve(argValue('--root') ?? scriptProjectRoot)
const releasePackageMode = argv.includes('--release-package')
const checkRemote = argv.includes('--check-remote')
const writeReport = !argv.includes('--no-write') && !releasePackageMode

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.avif', '.gif'])
const SOURCE_SKIP_DIRECTORIES = new Set([
    '.git', 'node_modules', 'coverage', 'graphify-out', 'audit-artifacts',
    'e2e-screenshots', 'test-results', 'playwright-report', 'runtime-temp',
])
const RELEASE_FORBIDDEN_SEGMENTS = new Set([
    'data', 'graphify-out', 'audit-artifacts', 'e2e-screenshots',
    'test-results', 'playwright-report', 'runtime-temp',
])
const SUSPICIOUS_IMAGE_NAME = /(?:^|[-_.])(screenshot|screen-shot|fixture|sample|example|mock|debug|capture|recording|secret|private|credential)(?:[-_.]|$)/iu
const STATIC_PUBLIC_PREFIXES = ['/images/', '/favicon.svg']
const CONTENT_REVIEWED_AT = '2026-08-10'

const EMPTY_ALT_MANUAL_REVIEWS = Object.freeze([
    {
        file: 'frontend/src/components/ui/MagicBento.tsx',
        line: 169,
        reason: '卡片媒体容器已 aria-hidden=true；卡片自身的标题与描述承担可访问名称，图片是重复装饰。',
    },
    {
        file: 'frontend/src/components/ui/SphereGallery.tsx',
        line: 473,
        reason: '图片位于具名 button 内；button aria-label 和相邻 strong 已完整表达图片说明、序号与动作，图片本身应静音。',
    },
    {
        file: 'frontend/src/pages/AICopilotPage/AttachmentTray.tsx',
        line: 54,
        reason: '附件名称、类型、大小、状态和删除动作均由同一列表项文本/控件表达；缩略图不引入额外操作或必需信息。',
    },
    {
        file: 'frontend/src/pages/ThinkingPalacePage/PoemImageGenerator.tsx',
        line: 158,
        reason: '图片位于具名预览 button 内；button aria-label 含序号、诗句或失败语义，图片是重复视觉。',
    },
])

const ORIGINAL_SIZE_TEXT_REVIEWS = Object.freeze({
    'tongbian-002': {
        visibleText: ['春眠不觉晓，处处闻啼鸟。', '夜来风雨声，花落知多少。', '唐·孟浩然'],
        comparison: 'passed_character_by_character',
        note: '原尺寸逐字核对题写诗句及作者，均与《春晓》标准文本和作者一致。',
    },
    'tongbian-003': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '原尺寸未发现可辨文字。',
    },
    'tongbian-005': {
        visibleText: ['登鹳雀楼', '黄河入海流', '唐·王之涣'],
        comparison: 'passed_character_by_character',
        note: '原尺寸并放大文字区域逐字核对，标题、诗句片段及作者均正确。',
    },
    'tongbian-006': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '原尺寸未发现可辨文字。',
    },
    'tongbian-008': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '原尺寸未发现可辨文字。',
    },
    'tongbian-014': {
        visibleText: ['枫桥夜泊'],
        comparison: 'passed_character_by_character',
        note: '原尺寸并放大文字区域逐字核对，标题正确，未发现其他可辨文字。',
    },
    'tongbian-017': {
        visibleText: ['故人西辞黄鹤楼，烟花三月下扬州。', '唐·李白'],
        comparison: 'passed_character_by_character',
        note: '原尺寸逐字核对诗句及作者，均正确。',
    },
    'tongbian-025': {
        visibleText: ['寻隐者不遇', '松下问童子，言师采药去。', '只在此山中，云深不知处。'],
        comparison: 'passed_character_by_character',
        note: '原尺寸逐字核对标题与全诗，均与标准文本一致。',
    },
    'tongbian-027': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '原尺寸未发现可辨文字。',
    },
    'tongbian-035': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '原尺寸未发现可辨文字。',
    },
    'tongbian-041': {
        visibleText: ['空山不见人，但闻人语响。', '返景入深林，复照青苔上。'],
        comparison: 'passed_character_by_character',
        note: '原尺寸逐字核对全诗；“返景”为《鹿柴》通行标准文本用字。',
    },
    'tongbian-061': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '原尺寸未发现可辨文字。',
    },
    'tongbian-066': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '原尺寸未发现可辨文字。',
    },
    'tongbian-067': {
        visibleText: ['寒雨连江夜入吴，平明送客楚山孤。', '洛阳亲友如相问，一片冰心在玉壶。'],
        comparison: 'passed_character_by_character',
        note: '原尺寸逐字核对全诗，均与标准文本一致。',
    },
    'tongbian-s09': {
        visibleText: ['早发白帝城', '朝辞白帝彩云间，千里江陵一日还。', '唐·李白'],
        comparison: 'passed_character_by_character',
        note: '原尺寸逐字核对标题、可见诗句及作者，均正确。',
    },
    'tongbian-s33': {
        visibleText: [
            '空山新雨后，天气晚来秋。',
            '明月松间照，清泉石上流。',
            '竹喧归浣女，莲动下渔舟。',
            '随意春芳歇，王孙自可留。',
        ],
        comparison: 'passed_character_by_character',
        note: '原尺寸逐字核对全诗，均与《山居秋暝》标准文本一致。',
    },
    'tongbian-007': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '新生成《江雪》原图及 1280×720 发布图均未出现可辨文字、题签、水印或生成标签。',
    },
    'tongbian-011': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '新生成重阳思乡场景原图及发布图均未出现可辨文字、题签、水印或生成标签。',
    },
    'tongbian-036': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '新生成《绝句》原图及发布图均未出现可辨文字、题签、水印或生成标签。',
    },
    'tongbian-043': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '新生成古琴雅集原图及发布图均未出现可辨文字、题签、水印或生成标签。',
    },
    'tongbian-078': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '新生成《出塞》原图及发布图均未出现可辨文字、旗号、水印或生成标签。',
    },
    'tongbian-s36': {
        visibleText: [],
        comparison: 'not_applicable_no_visible_text',
        note: '新生成唐代书斋原图及发布图均未出现可辨文字、题签、水印或生成标签。',
    },
})

const LEGACY_CURATED_IMAGES = [
    ['tongbian-002', '春晓', '孟浩然', '唐', '/uploads/generated/299f2bff1f671652.webp', 'b18e19237ab41b0adcaafc23b1bfee762a12a3daac2cd0645e12612e0b088e0f', '春日清晨与鸟鸣花木意象吻合，未见生成过程标签。'],
    ['tongbian-003', '静夜思', '李白', '唐', '/uploads/generated/ff3c2615d31183a0.webp', 'dacb1d4b79ee52140047512ac4be36d4d1559808a608099dc05f0dff811d79b5', '月夜、人物与思乡氛围吻合，未见生成过程标签。'],
    ['tongbian-005', '登鹳雀楼', '王之涣', '唐', '/uploads/generated/bc287e9861b35706.webp', 'c447e6c814889f187c115d06802e9b1793be9f270fff608d760a3eef9f8082c7', '高楼、落日与远眺构图吻合，未见生成过程标签。'],
    ['tongbian-006', '望庐山瀑布', '李白', '唐', '/uploads/generated/0a58547964fbeceb.webp', 'bbc3e511d19eb1bcf82d211ae1e480a6db2bb195c978966c8c91fbd6477c0563', '山岳飞瀑主体明确，未见生成过程标签。'],
    ['tongbian-008', '望天门山', '李白', '唐', '/uploads/generated/c44a55963dadce0c.webp', 'cd7bff7016003a9e04e1c5fe8fd1e9cd5b6ac1098bd092a7b4403c7affdb77f9', '江流、对峙青山与舟行构图吻合，未见生成过程标签。'],
    ['tongbian-014', '枫桥夜泊', '张继', '唐', '/uploads/generated/a0f6e78bb03bc799.webp', 'd16c6b3fa46165c183e1a2019b7885c3e294e7abc1713eadb6f57492a42b187e', '夜月、江船与泊舟意境吻合，未见生成过程标签。'],
    ['tongbian-017', '黄鹤楼送孟浩然之广陵', '李白', '唐', '/uploads/generated/3e3d923823011ca5.webp', 'efcf1bf60f3bce74e761400032d2770c3ae1b8333fbcdedf016aa52d8c8296a4', '楼阁、江面与送别孤帆主题吻合，未见生成过程标签。'],
    ['tongbian-025', '寻隐者不遇', '贾岛', '唐', '/uploads/generated/f2bdb9208757c6ed.webp', '60414f92ee2e736aaf8098db77d7ba864745ff1bf7530f7a2c86515be18a2ee0', '松林、山径与寻访人物主题吻合，未见生成过程标签。'],
    ['tongbian-027', '赠汪伦', '李白', '唐', '/uploads/generated/09e3bcfa6a6abfea.webp', 'b4254ea2b19db585237ae51398ca671e7380e6e688a27f484edcbd056df3baa5', '潭水、行舟与岸上送别主题吻合，未见生成过程标签。'],
    ['tongbian-035', '咏柳', '贺知章', '唐', '/uploads/generated/ba1ee4ac74b5d77c.webp', '66c8e0cf723ef8064a571bc6193a229486f67564ef33ec4f0b02430cc7ff9d70', '春柳与新绿主体明确，也可支撑折柳文化场景，未见生成过程标签。'],
    ['tongbian-041', '鹿柴', '王维', '唐', '/uploads/generated/37abf1a7f31c144d.webp', '936ed57db4379d84720d7b4df43b66d66346cf74e34758b34c707fa5cfe8f7f9', '幽深山林与返照意境吻合，未见生成过程标签。'],
    ['tongbian-061', '清明', '杜牧', '唐', '/uploads/generated/fb174360a86f5efe.webp', 'fd706a550ec1af6fa83ad7eedf6b313cd74c9f053ae59a10acafa83624f33f5a', '春雨、行人与村落意境吻合，未见生成过程标签。'],
    ['tongbian-066', '送元二使安西', '王维', '唐', '/uploads/generated/6caa493d86f5d6b7.webp', '3e4df93c1d0204548fa77f682cdc5e6527b6fd3e83ddef73e3120dba6b730b55', '客舍、柳色与人物送别主题吻合，可支撑阳关送别场景，未见生成过程标签。'],
    ['tongbian-067', '芙蓉楼送辛渐', '王昌龄', '唐', '/uploads/generated/a990700fed9f88bf.webp', '6314438000ba182e745562ea8f6373eee50e9520c58fc7dadf2a3cadb32bef3b', '寒雨江天与送客人物主题吻合，未见生成过程标签。'],
    ['tongbian-s09', '早发白帝城', '李白', '唐', '/uploads/generated/63149302d5d544aa.webp', '581ee209f2623eae29c6414325a3e8bb09bc78dc45ca7efcf172c0d8b5d5e4dd', '江行、舟船与重山主题吻合，未见生成过程标签。'],
    ['tongbian-s33', '山居秋暝', '王维', '唐', '/uploads/generated/902dcd093b7c1622.webp', 'c575788390e7e0ad5f7bf2e57a4d2dbf1bb066ad6bf4c29818765f4c8a5e4d88', '山林、清泉与秋日人物场景吻合，未见生成过程标签。'],
].map(([id, title, poet, dynasty, originUrl, sha256, observation]) => ({
    id,
    title,
    poet,
    dynasty,
    originUrl,
    sourcePath: `data/uploads/generated/starmap/${id}.webp`,
    publishedPath: `frontend/public/images/generated/starmap/${id}.webp`,
    publicUrl: `/images/generated/starmap/${id}.webp`,
    sourceKind: 'runtime-cache',
    sourceDisplay: 'original_640x360',
    sha256,
    expected: { format: 'webp', width: 640, height: 360, hasAlpha: true },
    contentReview: {
        status: 'passed',
        reviewedAt: CONTENT_REVIEWED_AT,
        method: '人工逐张原尺寸审阅；所有可见标题、作者、题签和诗句逐字对照标准文本；非自动 OCR。',
        checks: ['主题与清单诗题/场景一致', '可见文字逐字对照标准文本；无法确认即拒绝', '无可见生成过程标签', '非空白', '无明显占位或测试图'],
        observation,
        visibleTextReview: {
            status: 'passed',
            reviewedAt: CONTENT_REVIEWED_AT,
            sourceDisplay: 'original_640x360',
            ...ORIGINAL_SIZE_TEXT_REVIEWS[id],
        },
    },
}))

const NEW_CURATED_IMAGES = [
    ['tongbian-007', '江雪', '柳宗元', '唐', 'tongbian-007-v2.webp', 'a56397752bf82c202ad5a99b7ab90967eb1e6c997a43bfdb477129485a35cc60', '05810eb53a1fce92031e4ce19ee9896dd2d254dedef8752ebe0ecbba8c33518e', '寒江雪谷、孤舟与蓑笠独钓叙事准确，未见额外人物或现代物件。'],
    ['tongbian-011', '九月九日忆山东兄弟', '王维', '唐', 'tongbian-011-v2.webp', '7130aa9ffb38cdac46f4a258aa8a5a3ba8718aa42334ec9602ce6a8282abebee', 'c24761ceab51f2591927bc5dcd981c1a10d8b267a2d428da2050a22948c009a0', '登高、茱萸、远眺与远方亲友层次明确，唐代服饰语境合理。'],
    ['tongbian-036', '绝句', '杜甫', '唐', 'tongbian-036-v2.webp', '6605eab6eea5ae7d1b89630e19876f1a25f1e528cfc31f9f044f2a64ffdc1a21', '027c27002fde7d4c9582880239621bb445354c207f32eaf1d3af51c3201e62fc', '黄鹂、翠柳、白鹭、雪山与泊舟五组核心意象完整且主体清晰。'],
    ['tongbian-043', '古琴演奏', '文化场景', '唐', 'tongbian-043-v2.webp', 'dd32e8fc3d6c215c67db3eb06de6c46679e41462b002e95bcbeb95c61247c31a', 'b09fa0d5c1515a279a6de62efb4722c06121f5e5ba98884199a80b8fb797ecad', '松竹流泉、七弦琴、茶具与听琴人物构图完整，手势与器物可辨。'],
    ['tongbian-078', '出塞', '王昌龄', '唐', 'tongbian-078-v2.webp', 'c426a206140c2328dab2a6683370424e708db77bdd0ce7098ae35bef193779bd', '58750e97ab044c04b6a850ef73b2c111f1506abc1a2f7c957f22db8164933c78', '明月、关城、烽燧、荒漠与戍边骑将完整，气氛庄重且无战斗血腥。'],
    ['tongbian-s36', '唐代书斋', '文化场景', '唐', 'tongbian-s36-v2.webp', 'efd52936ccdf9eef4ed0362b14136102f517957951e7326124ae67f4a4eca054', 'decd8cbdfc79093ccd73017de773edb310cac5d2dd8b04f9b5a95441e1419402', '油灯、竹简、笔墨纸砚、书架与唐代文人夜读场景明确，无宋代池塘错配。'],
].map(([id, title, poet, dynasty, filename, sha256, sourceSha256, observation]) => ({
    id,
    title,
    poet,
    dynasty,
    originUrl: 'OpenAI built-in image_gen (C2PA source PNG)',
    sourcePath: null,
    sourceKind: 'built-in-imagegen',
    sourceDisplay: 'original_1672x941_and_release_1280x720',
    sourceSha256,
    publishedPath: `frontend/public/images/generated/starmap/${filename}`,
    publicUrl: `/images/generated/starmap/${filename}`,
    sha256,
    expected: { format: 'webp', width: 1280, height: 720, hasAlpha: false },
    manifest: {
        model: 'OpenAI built-in image_gen',
        promptVersion: 'competition-core-poetry-no-text-v1',
        perceptualHash: null,
        createdAt: '2026-08-11T12:42:00+08:00',
        transformation: 'C2PA PNG 1672×941 → centered 16:9 crop → WebP 1280×720 quality 90',
    },
    contentReview: {
        status: 'passed',
        reviewedAt: CONTENT_REVIEWED_AT,
        method: '人工逐张审阅 1672×941 原图与 1280×720 发布图；核对诗意、时代语境、器物、人物、可见文字与水印。',
        checks: ['主题与诗题/文化场景一致', '无可见文字或生成标签', '无现代物件', '人物和器物无明显畸变', '缩略图与原尺寸均具清晰叙事'],
        observation,
        visibleTextReview: {
            status: 'passed',
            reviewedAt: CONTENT_REVIEWED_AT,
            sourceDisplay: 'original_1672x941_and_release_1280x720',
            ...ORIGINAL_SIZE_TEXT_REVIEWS[id],
        },
    },
}))

const CURATED_IMAGES = [...LEGACY_CURATED_IMAGES, ...NEW_CURATED_IMAGES]

const REJECTED_RUNTIME_CANDIDATES = [
    {
        id: 'tongbian-007',
        title: '江雪',
        sourcePath: 'data/uploads/generated/starmap/tongbian-007.webp',
        sha256: '1d3ccaee0086b13062c0f7a7a3f831501bf486499ff6344a7a4d450965336473',
        code: 'VISIBLE_TEXT_CORRUPTION_OR_UNCERTAINTY',
        reason: '右侧题签开头可辨为“柳山无径…”，既不是《江雪》标准文本，末尾字形也无法可靠确认；按无法确认即拒绝。',
        fallbackUrl: '/images/generated/starmap/tongbian-007-v2.webp',
    },
    {
        id: 'tongbian-011',
        title: '九月九日忆山东兄弟',
        sourcePath: 'data/uploads/generated/starmap/tongbian-011.webp',
        sha256: '685f49b4ed0112f5cd9bced64965f5bc2c283a3a9ce5ee30c2bc6b21c489cff3',
        code: 'VISIBLE_TEXT_CORRUPTION',
        reason: '首句画成“独在九乡为异客”，其中“九乡”错误，标准文本应为“独在异乡为异客”。',
        fallbackUrl: '/images/generated/starmap/tongbian-011-v2.webp',
    },
    {
        id: 'tongbian-036',
        title: '绝句',
        sourcePath: 'data/uploads/generated/starmap/tongbian-036.webp',
        sha256: '2929a752f6fcc59bfe4d75f430bd616dbc56ea8ec246c4495a7a7c1b8d2af607',
        code: 'VISIBLE_GENERATION_PROMPT_ARTIFACT',
        reason: '图像底边清晰出现 starmap-poem-v3-no-watermark-unique-tongbian-036-attempt-1，和“无水印”描述矛盾。',
        fallbackUrl: '/images/generated/starmap/tongbian-036-v2.webp',
    },
    {
        id: 'tongbian-078',
        title: '出塞',
        sourcePath: 'data/uploads/generated/starmap/tongbian-078.webp',
        sha256: '774c1ffab470cb6785bc3aa77f27c6d719f7f4ca38d1f8214be04e22c9cd31a1',
        code: 'VISIBLE_GENERATION_PROMPT_ARTIFACT',
        reason: '图像黑色底边清晰出现 starmap-poem-v3-no-watermark-unique-tongbian-078-attempt-1。',
        fallbackUrl: '/images/generated/starmap/tongbian-078-v2.webp',
    },
    {
        id: 'tongbian-043',
        title: '竹里馆',
        sourcePath: 'data/uploads/generated/starmap/tongbian-043.webp',
        sha256: 'd79b9a5aaf2ba892043c7fbbdb71875999392596b4f150245a175bf82ce48fa5',
        code: 'VISIBLE_TEXT_CORRUPTION_OR_UNCERTAINTY',
        reason: '主标题明显重复成“竹里里馆”，标题旁小字亦无法可靠确认；按无法确认即拒绝。',
        fallbackUrl: '/images/generated/starmap/tongbian-043-v2.webp',
    },
    {
        id: 'tongbian-s36',
        title: '观书有感（其一）',
        sourcePath: 'data/uploads/generated/starmap/tongbian-s36.webp',
        sha256: 'bf7b81b7f238791089e7f2cab4e92f8f289e0d60fe741860f3aa5de497d40963',
        code: 'SEMANTIC_AND_ERA_MISMATCH',
        reason: '清单内容是宋代朱熹《观书有感》的池塘/书院意境，不是配置声称的“唐代书斋”陈设。',
        fallbackUrl: '/images/generated/starmap/tongbian-s36-v2.webp',
    },
]

const HERO_C2PA_RECORDS = [
    {
        path: 'frontend/public/images/generated/culture-context-hero-v1.png',
        sha256: '5e89984cd5d58abee9f170399fc63b6e291c89dfaf250f52b2b4c705c1fbd62b',
        activeManifest: 'urn:c2pa:9a7cd355-051e-47ff-892e-3ff5fa978c00',
    },
    {
        path: 'frontend/public/images/generated/workbench-bloom-hero-v1.png',
        sha256: 'c352cbaba6ea7d88c82bf7a20fbc6163855a106d06e98770abdee39a42349d80',
        activeManifest: 'urn:c2pa:f9bc8347-287d-45d7-9faa-45bedbf3a702',
    },
]

const findings = []
function finding(severity, code, file, message, details = undefined) {
    findings.push({ severity, code, file: file ? toRelative(file) : null, message, ...(details ? { details } : {}) })
}

function toRelative(absoluteOrRelative) {
    const absolute = path.isAbsolute(absoluteOrRelative) ? absoluteOrRelative : path.join(auditRoot, absoluteOrRelative)
    return path.relative(auditRoot, absolute).replaceAll('\\', '/') || '.'
}

async function exists(target) {
    try { await access(target); return true } catch { return false }
}

async function sha256File(file) {
    return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function atomicWrite(destination, content) {
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.${process.pid}.tmp`
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, destination)
}

async function walkFiles(start, options = {}) {
    if (!(await exists(start))) return []
    const result = []
    const skip = options.skip ?? new Set()
    const visit = async (directory) => {
        const directoryInfo = await lstat(directory)
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
            throw new Error(`拒绝遍历非普通目录或符号链接：${directory}`)
        }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isDirectory() && skip.has(entry.name)) continue
            const absolute = path.join(directory, entry.name)
            const info = await lstat(absolute)
            if (info.isSymbolicLink()) {
                finding('warning', 'SYMLINK_SKIPPED', absolute, '资产审计拒绝跟随符号链接。')
                continue
            }
            if (info.isDirectory()) await visit(absolute)
            else if (info.isFile()) result.push(absolute)
        }
    }
    await visit(start)
    return result
}

const imageFilesUnder = async (start, skip = SOURCE_SKIP_DIRECTORIES) =>
    (await walkFiles(start, { skip })).filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))

function detectMagic(buffer) {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif'
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
        && /^(?:avif|avis)$/u.test(buffer.subarray(8, 12).toString('ascii'))) return 'avif'
    const textHead = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').replace(/^\uFEFF/u, '').trimStart()
    if (/<svg(?:\s|>)/iu.test(textHead)) return 'svg'
    return 'unknown'
}

function extensionFormat(extension) {
    if (extension === '.jpg' || extension === '.jpeg') return 'jpeg'
    return extension.slice(1)
}

function pngChunkTypes(buffer) {
    if (detectMagic(buffer) !== 'png') return []
    const chunks = []
    let offset = 8
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset)
        const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
        if (offset + 12 + length > buffer.length) break
        chunks.push(type)
        offset += 12 + length
        if (type === 'IEND') break
    }
    return chunks
}

function groupBy(values, keyFor) {
    const groups = new Map()
    for (const value of values) {
        const key = keyFor(value)
        groups.set(key, [...(groups.get(key) ?? []), value])
    }
    return groups
}

let sharp = null
try {
    const requireFromBackend = createRequire(path.join(scriptProjectRoot, 'backend', 'package.json'))
    sharp = requireFromBackend('sharp')
} catch (error) {
    finding('blocker', 'SHARP_UNAVAILABLE', null, '无法加载 backend 的 Sharp，不能完成逐像素解码门禁。', String(error?.message ?? error))
}

async function analyzeImage(file, sampleSize = 320) {
    const buffer = await readFile(file)
    const extension = path.extname(file).toLowerCase()
    const magic = detectMagic(buffer)
    const expectedFormat = extensionFormat(extension)
    const result = {
        path: toRelative(file),
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        extension,
        magic,
        magicMatchesExtension: magic === expectedFormat,
    }
    if (!result.magicMatchesExtension) return { ...result, decodeError: `扩展名 ${extension} 与魔数 ${magic} 不一致` }

    if (magic === 'svg') {
        const source = buffer.toString('utf8')
        result.svgSecurity = {
            scripts: (source.match(/<script\b/giu) ?? []).length,
            inlineEventHandlers: (source.match(/\son[a-z]+\s*=/giu) ?? []).length,
            javascriptUrls: (source.match(/javascript\s*:/giu) ?? []).length,
            foreignObjects: (source.match(/<foreignObject\b/giu) ?? []).length,
            remoteReferences: (source.match(/(?:href|xlink:href)\s*=\s*["'](?:https?:)?\/\//giu) ?? []).length,
        }
    }
    if (!sharp) return { ...result, decodeError: 'Sharp unavailable' }
    try {
        const image = sharp(buffer, { failOn: 'error', limitInputPixels: 25_000_000 })
        const metadata = await image.metadata()
        const sampled = await sharp(buffer, { failOn: 'error', limitInputPixels: 25_000_000 })
            .resize({ width: sampleSize, height: sampleSize, fit: 'inside', withoutEnlargement: true })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true })
        let transparent = 0
        let visible = 0
        let lumaMean = 0
        let lumaM2 = 0
        for (let offset = 0; offset < sampled.data.length; offset += sampled.info.channels) {
            const alpha = sampled.data[offset + 3] ?? 255
            if (alpha <= 4) {
                transparent++
                continue
            }
            visible++
            const luma = 0.2126 * sampled.data[offset] + 0.7152 * sampled.data[offset + 1] + 0.0722 * sampled.data[offset + 2]
            const delta = luma - lumaMean
            lumaMean += delta / visible
            lumaM2 += delta * (luma - lumaMean)
        }
        const pixels = transparent + visible
        const transparentRatio = pixels > 0 ? transparent / pixels : 1
        const visibleLumaStdDev = visible > 1 ? Math.sqrt(lumaM2 / (visible - 1)) : 0
        return {
            ...result,
            format: metadata.format,
            width: metadata.width ?? null,
            height: metadata.height ?? null,
            pages: metadata.pages ?? 1,
            hasAlpha: metadata.hasAlpha ?? false,
            orientation: metadata.orientation ?? null,
            sample: {
                width: sampled.info.width,
                height: sampled.info.height,
                transparentRatio: Number(transparentRatio.toFixed(6)),
                visibleLumaMean: Number(lumaMean.toFixed(3)),
                visibleLumaStdDev: Number(visibleLumaStdDev.toFixed(3)),
            },
            pngChunks: magic === 'png' ? pngChunkTypes(buffer) : undefined,
        }
    } catch (error) {
        return { ...result, decodeError: String(error?.message ?? error) }
    }
}

async function auditImageFiles(files, scope, { runtime = false, sampleSize = 320 } = {}) {
    const assets = []
    for (const file of files) {
        const asset = await analyzeImage(file, sampleSize)
        assets.push(asset)
        const severity = runtime ? 'warning' : 'blocker'
        if (asset.decodeError) {
            finding(severity, 'IMAGE_DECODE_FAILED', file, asset.decodeError)
            continue
        }
        if (!asset.width || !asset.height || asset.width <= 1 || asset.height <= 1) {
            finding(severity, 'TINY_OR_DIMENSIONLESS_IMAGE', file, `尺寸 ${asset.width}x${asset.height} 不可作为有效产品图像。`)
        }
        if (asset.width * asset.height > 25_000_000) {
            finding(severity, 'IMAGE_PIXEL_BUDGET_EXCEEDED', file, `像素数 ${asset.width * asset.height} 超过 2500 万解码上限。`)
        }
        if (asset.bytes > 5 * 1024 * 1024) {
            finding('warning', 'IMAGE_FILE_LARGE', file, `单图 ${(asset.bytes / 1024 / 1024).toFixed(2)} MiB，需确认首屏加载必要性。`)
        }
        if (asset.sample?.transparentRatio >= 0.995 || asset.sample?.visibleLumaStdDev < 0.35) {
            finding(severity, 'IMAGE_EFFECTIVELY_BLANK', file,
                `透明占比 ${asset.sample?.transparentRatio ?? '未知'}，可见像素亮度标准差 ${asset.sample?.visibleLumaStdDev ?? '未知'}。`)
        }
        if (asset.svgSecurity && Object.values(asset.svgSecurity).some((value) => value > 0)) {
            finding(severity, 'SVG_ACTIVE_OR_REMOTE_CONTENT', file, 'SVG 含脚本、事件、javascript、foreignObject 或远程引用。', asset.svgSecurity)
        }
    }
    const duplicateGroups = [...groupBy(assets, (asset) => asset.sha256).entries()]
        .filter(([, group]) => group.length > 1)
        .map(([sha256, group]) => ({ sha256, files: group.map((asset) => asset.path) }))
    for (const group of duplicateGroups) {
        finding('warning', 'DUPLICATE_IMAGE_BYTES', group.files[0], `${scope} 内 ${group.files.length} 个图像字节完全重复。`, group)
    }
    return { scope, files: assets, duplicateGroups }
}

function lineNumberAt(source, index) {
    return source.slice(0, index).split(/\r?\n/u).length
}

async function scanFrontendReferences() {
    const sourceRoot = path.join(auditRoot, 'frontend', 'src')
    const backendSourceRoot = path.join(auditRoot, 'backend', 'src')
    const candidates = (await walkFiles(sourceRoot, { skip: SOURCE_SKIP_DIRECTORIES }))
        .filter((file) => /\.(?:ts|tsx|css|html)$/iu.test(file)
            && !/\.(?:test|spec)\.[^.]+$/iu.test(file)
            && !/[\\/](?:__tests__|_dev)[\\/]/u.test(file))
    if (await exists(backendSourceRoot)) {
        candidates.push(...(await walkFiles(backendSourceRoot, { skip: SOURCE_SKIP_DIRECTORIES }))
            .filter((file) => /\.ts$/iu.test(file)
                && !/\.(?:test|spec)\.ts$/iu.test(file)
                && !/[\\/]__tests__[\\/]/u.test(file)))
    }
    const indexFile = path.join(auditRoot, 'frontend', 'index.html')
    if (await exists(indexFile)) candidates.push(indexFile)
    const references = []
    const imageTags = []
    const remoteReferences = []
    const productionRuntimeStarmapReferences = []
    const productionSvgReferences = []
    const localAbsoluteReferences = []
    const combinedSources = []
    for (const file of candidates) {
        const source = await readFile(file, 'utf8')
        combinedSources.push(source)
        const frontendMarkupSource = toRelative(file).startsWith('frontend/')
        for (const match of frontendMarkupSource ? source.matchAll(/<img\b[\s\S]*?>/giu) : []) {
            const lastBlockStart = source.lastIndexOf('/*', match.index)
            const lastBlockEnd = source.lastIndexOf('*/', match.index)
            const lastHtmlStart = source.lastIndexOf('<!--', match.index)
            const lastHtmlEnd = source.lastIndexOf('-->', match.index)
            if (lastBlockStart > lastBlockEnd || lastHtmlStart > lastHtmlEnd) continue
            const tag = match[0]
            const hasAlt = /\balt\s*=/iu.test(tag)
            const emptyAlt = /\balt\s*=\s*(?:["']\s*["']|\{\s*["']\s*["']\s*\})/iu.test(tag)
            const decorativeSignal = /\baria-hidden\s*=\s*(?:["']true["']|\{true\})/iu.test(tag)
                || /\baria-hidden(?=\s*(?:[A-Za-z][\w:-]*\s*=|\/?>))/u.test(tag)
                || /\brole\s*=\s*["']presentation["']/iu.test(tag)
            const relativeFile = toRelative(file)
            const line = lineNumberAt(source, match.index)
            const manualReview = emptyAlt
                ? EMPTY_ALT_MANUAL_REVIEWS.find((item) => item.file === relativeFile && item.line === line) ?? null
                : null
            const record = { file: relativeFile, line, hasAlt, emptyAlt, decorativeSignal, manualReview }
            imageTags.push(record)
            if (!hasAlt) finding('blocker', 'IMG_ALT_MISSING', file, `第 ${record.line} 行 <img> 缺少 alt。`)
        }
        for (const match of source.matchAll(/(?:["'`(])((?:\/|https?:\/\/)[^\s"'`()]+?\.(?:png|jpe?g|webp|svg|avif|gif)(?:\?[^\s"'`()]+)?)/giu)) {
            const rawUrl = match[1]
            const pathname = rawUrl.startsWith('http') ? new URL(rawUrl).pathname : rawUrl.split(/[?#]/u)[0]
            const record = { file: toRelative(file), line: lineNumberAt(source, match.index), url: rawUrl }
            const legacySvgRewriteKey = record.file === 'frontend/src/lib/poem-images.ts'
                && pathname.startsWith('/images/') && pathname.endsWith('.svg')
            const vectorIconReference = record.file === 'frontend/index.html' && pathname === '/favicon.svg'
            references.push(record)
            if (rawUrl.startsWith('http')) remoteReferences.push(record)
            if (pathname.startsWith('/uploads/generated/starmap/')) {
                productionRuntimeStarmapReferences.push(record)
                finding('blocker', 'PRODUCTION_MAPPING_TO_IGNORED_RUNTIME_CACHE', file,
                    `第 ${record.line} 行把被 Git/发布边界排除的 starmap 缓存当成生产静态资源：${rawUrl}`)
            } else if (pathname.endsWith('.svg') && !legacySvgRewriteKey && !vectorIconReference) {
                productionSvgReferences.push(record)
                finding('blocker', 'PRODUCTION_CONTENT_SVG_REFERENCE', file,
                    `第 ${record.line} 行仍把 SVG 当作正式内容图：${rawUrl}`)
            } else if (STATIC_PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) && !legacySvgRewriteKey) {
                const publicFile = path.join(auditRoot, 'frontend', 'public', pathname.replace(/^\//u, ''))
                if (!(await exists(publicFile))) {
                    finding('blocker', 'STATIC_REFERENCE_MISSING', file, `第 ${record.line} 行引用不存在的 public 资源：${rawUrl}`)
                }
            }
        }
        for (const match of source.matchAll(/(?<![A-Za-z])(?:file:\/\/\/?|[A-Za-z]:[\\/])[^\r\n"'`]*\.(?:png|jpe?g|webp|svg|avif|gif)/giu)) {
            localAbsoluteReferences.push({ file: toRelative(file), line: lineNumberAt(source, match.index), value: match[0] })
            finding('blocker', 'LOCAL_ABSOLUTE_IMAGE_REFERENCE', file, `第 ${lineNumberAt(source, match.index)} 行包含本机绝对图像路径。`)
        }
    }

    const publicImages = await imageFilesUnder(path.join(auditRoot, 'frontend', 'public'))
    const allText = combinedSources.join('\n')
    const unconsumedPublicAssets = publicImages
        .filter((file) => {
            const publicUrl = `/${path.relative(path.join(auditRoot, 'frontend', 'public'), file).replaceAll('\\', '/')}`
            return !allText.includes(publicUrl) && !allText.includes(path.basename(file))
        })
        .map(toRelative)
    if (unconsumedPublicAssets.length > 0) {
        finding('warning', 'UNCONSUMED_PUBLIC_IMAGES', unconsumedPublicAssets[0],
            `${unconsumedPublicAssets.length} 个 public 图像未发现生产消费者；保留不会破坏运行，但会进入 Vite/发布包。`, unconsumedPublicAssets)
    }

    const emptyAltWithoutAcceptedSemantics = imageTags
        .filter((item) => item.emptyAlt && !item.decorativeSignal && !item.manualReview)
    for (const item of emptyAltWithoutAcceptedSemantics) {
        finding('blocker', 'IMG_EMPTY_ALT_CONTEXT_UNREVIEWED', item.file,
            `第 ${item.line} 行使用空 alt，但既无标签级装饰语义，也无逐项人工语境复核。`)
    }

    const remoteChecks = []
    if (checkRemote) {
        for (const reference of remoteReferences) {
            try {
                const response = await fetch(reference.url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8_000) })
                const ok = response.ok && /^image\//iu.test(response.headers.get('content-type') ?? '')
                remoteChecks.push({ ...reference, status: response.status, contentType: response.headers.get('content-type'), ok })
                if (!ok) finding('blocker', 'REMOTE_IMAGE_UNAVAILABLE', reference.file, `远程图像 ${reference.url} 返回 ${response.status}。`)
            } catch (error) {
                remoteChecks.push({ ...reference, ok: false, error: String(error?.message ?? error) })
                finding('blocker', 'REMOTE_IMAGE_UNAVAILABLE', reference.file, `远程图像 ${reference.url} 无法验证。`)
            }
        }
    }
    return {
        scannedFiles: candidates.length,
        staticImageReferences: references,
        productionRuntimeStarmapReferences,
        productionSvgReferences,
        localAbsoluteReferences,
        remoteReferences,
        remoteChecks,
        imageTags: {
            total: imageTags.length,
            missingAlt: imageTags.filter((item) => !item.hasAlt),
            emptyAlt: imageTags.filter((item) => item.emptyAlt),
            emptyAltWithoutTagLocalDecorativeSignal: imageTags.filter((item) => item.emptyAlt && !item.decorativeSignal),
            manuallyReviewedEmptyAlt: imageTags.filter((item) => item.emptyAlt && item.manualReview),
            emptyAltWithoutAcceptedSemantics,
            note: '空 alt 只允许标签级 aria-hidden/presentation，或由具名控件/相邻文本完整表达且已逐项人工复核的重复视觉；其他场景阻断。',
        },
        unconsumedPublicAssets,
    }
}

async function auditReleaseMapping() {
    const mappingFile = path.join(auditRoot, 'frontend', 'src', 'lib', 'poem-generated-images.ts')
    const poemImagesFile = path.join(auditRoot, 'frontend', 'src', 'lib', 'poem-images.ts')
    const mappingSource = await readFile(mappingFile, 'utf8')
    const poemImagesSource = await readFile(poemImagesFile, 'utf8')
    const entries = [...mappingSource.matchAll(/["'](tongbian-[^"']+)["']\s*:\s*["']([^"']+)["']/gu)]
        .map((match) => ({ id: match[1], url: match[2] }))
    const expectedById = new Map(CURATED_IMAGES.map((item) => [item.id, item]))
    if (entries.length !== CURATED_IMAGES.length) {
        finding('blocker', 'RELEASE_MAPPING_COUNT_MISMATCH', mappingFile,
            `可发布星图映射 ${entries.length} 项，要求与已审计精选清单 ${CURATED_IMAGES.length} 项完全一致。`)
    }
    if (new Set(entries.map((entry) => entry.url)).size !== entries.length) {
        finding('blocker', 'RELEASE_MAPPING_REUSES_IMAGE', mappingFile, '多个诗 ID 指向同一发布图像，违反一诗一图映射边界。')
    }
    for (const entry of entries) {
        const expected = expectedById.get(entry.id)
        if (!expected || entry.url !== expected.publicUrl) {
            finding('blocker', 'RELEASE_MAPPING_NOT_CURATED', mappingFile, `${entry.id} → ${entry.url} 不在已审计发布清单。`)
            continue
        }
        const publicFile = path.join(auditRoot, 'frontend', 'public', entry.url.replace(/^\//u, ''))
        if (!(await exists(publicFile))) finding('blocker', 'RELEASE_MAPPING_TARGET_MISSING', publicFile, `${entry.id} 的发布文件不存在。`)
    }
    for (const expected of CURATED_IMAGES) {
        if (!entries.some((entry) => entry.id === expected.id && entry.url === expected.publicUrl)) {
            finding('blocker', 'CURATED_MAPPING_MISSING', mappingFile, `精选资源 ${expected.id} 未进入唯一发布映射。`)
        }
    }
    const helperCalls = [...poemImagesSource.matchAll(/releasedStarmapImagePath\(["']([^"']+)["']\)/gu)].map((match) => match[1])
    for (const id of helperCalls) {
        if (!expectedById.has(id)) finding('blocker', 'POEM_CONFIG_USES_UNCURATED_IMAGE', poemImagesFile, `poem-images.ts 使用未审计 ID ${id}。`)
    }
    const fallbackAssertions = [
        ["id: 'poem-jueju'", "imagePath: releasedStarmapImagePath('tongbian-036')"],
        ["id: 'poem-jiangxue'", "imagePath: releasedStarmapImagePath('tongbian-007')"],
        ["id: 'poem-jiuyuejiuyi'", "imagePath: releasedStarmapImagePath('tongbian-011')"],
        ["id: 'poem-chusai'", "imagePath: releasedStarmapImagePath('tongbian-078')"],
        ["id: 'guqin-playing'", "imagePath: releasedStarmapImagePath('tongbian-043')"],
        ["id: 'tang-study'", "imagePath: releasedStarmapImagePath('tongbian-s36')"],
    ]
    let fallbackCursor = 0
    for (const [idMarker, pathMarker] of fallbackAssertions) {
        const idIndex = poemImagesSource.indexOf(idMarker, fallbackCursor)
        const pathIndex = poemImagesSource.indexOf(pathMarker, idIndex)
        if (idIndex < 0 || pathIndex < idIndex || pathIndex - idIndex > 500) {
            finding('blocker', 'REJECTED_IMAGE_REPLACEMENT_MISSING', poemImagesFile, `${idMarker} 没有明确使用 ${pathMarker}。`)
        }
        fallbackCursor = Math.max(fallbackCursor, idIndex + 1)
    }
    for (const rejected of REJECTED_RUNTIME_CANDIDATES) {
        const rejectedUrl = `/images/generated/starmap/${rejected.id}.webp`
        if (entries.some((entry) => entry.url === rejectedUrl)) {
            finding('blocker', 'REJECTED_IMAGE_REINTRODUCED', mappingFile, `${rejected.id} 的旧候选已因 ${rejected.code} 被拒绝，不得重新进入生产映射。`)
        }
        const publicCandidate = path.join(auditRoot, 'frontend', 'public', 'images', 'generated', 'starmap', `${rejected.id}.webp`)
        const distCandidate = path.join(auditRoot, 'frontend', 'dist', 'images', 'generated', 'starmap', `${rejected.id}.webp`)
        if (await exists(publicCandidate) || await exists(distCandidate)) {
            finding('blocker', 'REJECTED_IMAGE_SHIPPED', (await exists(publicCandidate)) ? publicCandidate : distCandidate,
                `${rejected.id} 被拒绝但仍进入 public/dist。`)
        }
    }
    return { file: toRelative(mappingFile), entries, helperCallIds: [...new Set(helperCalls)].sort() }
}

function hammingDistance(left, right) {
    if (typeof left !== 'string' || left.length !== right?.length) return null
    let distance = 0
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) distance++
    return distance
}

async function auditCuratedImages(publicInventory) {
    const publicByPath = new Map(publicInventory.files.map((item) => [item.path, item]))
    const manifestPath = path.join(auditRoot, 'data', 'uploads', 'generated', 'starmap', 'manifest.json')
    const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null
    const curatedIds = new Set(CURATED_IMAGES.map((item) => item.id))
    const textReviewIds = Object.keys(ORIGINAL_SIZE_TEXT_REVIEWS)
    const missingTextReviews = [...curatedIds].filter((id) => !textReviewIds.includes(id))
    const orphanTextReviews = textReviewIds.filter((id) => !curatedIds.has(id))
    if (textReviewIds.length !== CURATED_IMAGES.length || missingTextReviews.length > 0 || orphanTextReviews.length > 0) {
        finding('blocker', 'CURATED_TEXT_REVIEW_SET_MISMATCH', 'scripts/audit-image-assets.mjs',
            '原尺寸可见文字复核清单必须与精选发布清单逐项完全一致。', { missingTextReviews, orphanTextReviews })
    }
    const selected = []
    for (const expected of CURATED_IMAGES) {
        const textReview = expected.contentReview.visibleTextReview
        if (!textReview
            || textReview.status !== 'passed'
            || textReview.reviewedAt !== CONTENT_REVIEWED_AT
            || textReview.sourceDisplay !== expected.sourceDisplay
            || !Array.isArray(textReview.visibleText)
            || !['passed_character_by_character', 'not_applicable_no_visible_text'].includes(textReview.comparison)
            || (textReview.visibleText.length > 0 && textReview.comparison !== 'passed_character_by_character')
            || (textReview.visibleText.length === 0 && textReview.comparison !== 'not_applicable_no_visible_text')) {
            finding('blocker', 'CURATED_TEXT_REVIEW_INVALID', expected.publishedPath,
                `${expected.id} 缺少合格的原尺寸逐字复核证据。`, { textReview })
        }
        const target = publicByPath.get(expected.publishedPath)
        if (!target) {
            finding('blocker', 'CURATED_IMAGE_MISSING', expected.publishedPath, `${expected.id} 未出现在 public 图像清单。`)
            continue
        }
        const decodeMatches = !target.decodeError
            && target.magic === expected.expected.format
            && target.width === expected.expected.width
            && target.height === expected.expected.height
            && target.hasAlpha === expected.expected.hasAlpha
        if (target.sha256 !== expected.sha256 || !decodeMatches) {
            finding('blocker', 'CURATED_IMAGE_INTEGRITY_MISMATCH', expected.publishedPath,
                `${expected.id} 的哈希、格式、尺寸或 alpha 与审核基线不一致。`, { expected: expected.expected, actual: target })
        }
        let source = null
        let origin = null
        let manifestEntry = null
        if (!releasePackageMode && manifest && expected.sourceKind === 'runtime-cache') {
            const sourceFile = path.join(auditRoot, expected.sourcePath)
            if (!(await exists(sourceFile))) {
                finding('blocker', 'CURATED_SOURCE_MISSING', sourceFile, `${expected.id} 的精选来源缓存缺失，无法复核复制链。`)
            } else {
                source = { path: expected.sourcePath, sha256: await sha256File(sourceFile) }
                if (source.sha256 !== expected.sha256 || source.sha256 !== target.sha256) {
                    finding('blocker', 'CURATED_SOURCE_PUBLISHED_HASH_MISMATCH', sourceFile, `${expected.id} 的来源缓存与发布副本不一致。`)
                }
            }
            const originFile = path.join(auditRoot, 'data', expected.originUrl.replace(/^\//u, ''))
            if (await exists(originFile)) origin = { path: toRelative(originFile), sha256: await sha256File(originFile), bytes: (await stat(originFile)).size }
            manifestEntry = manifest[expected.id] ?? null
            if (!manifestEntry
                || manifestEntry.title !== expected.title
                || manifestEntry.poet !== expected.poet
                || manifestEntry.dynasty !== expected.dynasty
                || manifestEntry.sourceUrl !== expected.originUrl
                || manifestEntry.model !== 'wan2.7-image') {
                finding('blocker', 'CURATED_MANIFEST_MISMATCH', manifestPath, `${expected.id} 的生成清单元数据与审核基线不一致。`)
            }
        }
        selected.push({
            id: expected.id,
            title: expected.title,
            poet: expected.poet,
            dynasty: expected.dynasty,
            sourcePath: expected.sourcePath,
            originSourceUrl: expected.originUrl,
            originSource: origin,
            publishedPath: expected.publishedPath,
            publicUrl: expected.publicUrl,
            expectedSha256: expected.sha256,
            sourceSha256: source?.sha256 ?? expected.sourceSha256 ?? expected.sha256,
            publishedSha256: target.sha256,
            decode: {
                status: decodeMatches ? 'passed' : 'failed',
                format: target.format ?? target.magic,
                width: target.width,
                height: target.height,
                hasAlpha: target.hasAlpha,
                transparentRatio: target.sample?.transparentRatio,
                visibleLumaStdDev: target.sample?.visibleLumaStdDev,
            },
            manifest: manifestEntry ? {
                model: manifestEntry.model,
                promptVersion: manifestEntry.promptVersion,
                perceptualHash: manifestEntry.perceptualHash,
                createdAt: manifestEntry.createdAt,
            } : expected.manifest ?? {
                model: 'wan2.7-image',
                promptVersion: 'starmap-poem-v3-no-watermark-unique',
                note: '发布包不携带 data 生成清单；源仓审计报告保留完整清单交叉验证。',
            },
            contentReview: expected.contentReview,
        })
    }
    let closestPair = null
    if (manifest) {
        for (let leftIndex = 0; leftIndex < selected.length; leftIndex++) {
            for (let rightIndex = leftIndex + 1; rightIndex < selected.length; rightIndex++) {
                const distance = hammingDistance(selected[leftIndex].manifest?.perceptualHash, selected[rightIndex].manifest?.perceptualHash)
                if (distance != null && (!closestPair || distance < closestPair.distance)) {
                    closestPair = { left: selected[leftIndex].id, right: selected[rightIndex].id, distance, bits: 256 }
                }
            }
        }
        if (closestPair && closestPair.distance <= 35) {
            finding('blocker', 'CURATED_PERCEPTUAL_NEAR_DUPLICATE', manifestPath, '精选图片存在过近感知哈希。', closestPair)
        }
    }
    return { count: selected.length, closestPerceptualPair: closestPair, assets: selected }
}

async function auditRejectedCandidates() {
    const records = []
    for (const item of REJECTED_RUNTIME_CANDIDATES) {
        const source = path.join(auditRoot, item.sourcePath)
        let sourcePresent = false
        let actualSha256 = null
        if (!releasePackageMode && await exists(source)) {
            sourcePresent = true
            actualSha256 = await sha256File(source)
            if (actualSha256 !== item.sha256) {
                finding('warning', 'REJECTED_SOURCE_CHANGED', source, `${item.id} 的已拒绝证据哈希发生变化，需要重新人工检查。`)
            }
        }
        const fallback = path.join(auditRoot, 'frontend', 'public', item.fallbackUrl.replace(/^\//u, ''))
        let fallbackAsset = null
        if (!(await exists(fallback))) {
            finding('blocker', 'REJECTED_REPLACEMENT_FILE_MISSING', fallback, `${item.id} 的随包 WebP 替代图不存在。`)
        } else {
            fallbackAsset = await analyzeImage(fallback)
            if (fallbackAsset.decodeError || fallbackAsset.magic !== 'webp'
                || fallbackAsset.width !== 1280 || fallbackAsset.height !== 720) {
                finding('blocker', 'REJECTED_REPLACEMENT_INVALID', fallback,
                    `${item.id} 的随包 WebP 替代图无法解码或尺寸不是 1280×720。`, fallbackAsset)
            }
        }
        records.push({
            ...item,
            sourcePresent,
            actualSha256,
            fallbackAsset: fallbackAsset ? {
                path: fallbackAsset.path,
                sha256: fallbackAsset.sha256,
                decodeStatus: fallbackAsset.decodeError ? 'failed' : 'passed',
                format: fallbackAsset.format ?? fallbackAsset.magic,
                width: fallbackAsset.width,
                height: fallbackAsset.height,
                svgSecurity: fallbackAsset.svgSecurity,
            } : null,
            disposition: 'legacy_candidate_excluded_and_replaced_by_reviewed_v2_webp',
        })
    }
    return records
}

async function comparePublicAndDist(publicInventory, sourceInventory, distInventory) {
    const publicRoot = path.join(auditRoot, 'frontend', 'public')
    const distRoot = path.join(auditRoot, 'frontend', 'dist')
    const distByRelative = new Map(distInventory.files.map((item) => [path.relative(distRoot, path.join(auditRoot, item.path)).replaceAll('\\', '/'), item]))
    const expectedPaths = new Set()
    const missing = []
    const mismatched = []
    for (const asset of publicInventory.files) {
        const relative = path.relative(publicRoot, path.join(auditRoot, asset.path)).replaceAll('\\', '/')
        expectedPaths.add(relative)
        const built = distByRelative.get(relative)
        if (!built) missing.push(relative)
        else if (built.sha256 !== asset.sha256) mismatched.push({ path: relative, publicSha256: asset.sha256, distSha256: built.sha256 })
    }
    const sourceHashes = new Set(sourceInventory.files.map((item) => item.sha256))
    const untracked = distInventory.files.filter((asset) => {
        const relative = path.relative(distRoot, path.join(auditRoot, asset.path)).replaceAll('\\', '/')
        return !expectedPaths.has(relative) && !sourceHashes.has(asset.sha256)
    }).map((asset) => asset.path)
    for (const relative of missing) finding('blocker', 'DIST_PUBLIC_IMAGE_MISSING', path.join(distRoot, relative), 'Vite dist 缺少 public 图像，可能是构建陈旧或复制失败。')
    for (const item of mismatched) finding('blocker', 'DIST_PUBLIC_IMAGE_HASH_MISMATCH', path.join(distRoot, item.path), 'Vite dist 图像与 public 字节不一致。', item)
    for (const file of untracked) finding('blocker', 'DIST_UNTRACKED_IMAGE', file, 'dist 含无法追溯到 public/src 的陈旧或夹具图像。')
    return {
        expectedFromPublic: publicInventory.files.length,
        presentInDist: publicInventory.files.length - missing.length,
        hashMatched: publicInventory.files.length - missing.length - mismatched.length,
        missing,
        mismatched,
        untracked,
        status: missing.length === 0 && mismatched.length === 0 && untracked.length === 0 ? 'passed' : 'failed',
    }
}

async function auditHeroProvenance(publicInventory) {
    const publicByPath = new Map(publicInventory.files.map((asset) => [asset.path, asset]))
    const records = []
    for (const expected of HERO_C2PA_RECORDS) {
        const file = path.join(auditRoot, expected.path)
        const asset = publicByPath.get(expected.path)
        if (!asset) {
            finding('blocker', 'C2PA_HERO_MISSING', file, '带 C2PA 来源声明的核心首屏图缺失。')
            continue
        }
        const buffer = await readFile(file)
        const latin1 = buffer.toString('latin1')
        const claims = {
            caBXChunk: pngChunkTypes(buffer).includes('caBX'),
            activeManifestIdPresent: latin1.includes(expected.activeManifest.replace(/^urn:c2pa:/u, '')),
            gptImageClaimPresent: latin1.includes('gpt-image'),
            trainedAlgorithmicMediaClaimPresent: latin1.includes('trainedAlgorithmicMedia'),
            openAiMediaServiceClaimPresent: latin1.includes('OpenAI Media Service'),
        }
        if (asset.sha256 !== expected.sha256 || Object.values(claims).some((value) => !value)) {
            finding('blocker', 'C2PA_HERO_PROVENANCE_MISMATCH', file, '核心首屏 PNG 的哈希或内嵌 C2PA 声明与审核基线不一致。', claims)
        }
        records.push({
            ...expected,
            actualSha256: asset.sha256,
            claims,
            decode: { width: asset.width, height: asset.height, hasAlpha: asset.hasAlpha },
            externalCryptographicValidationRecord: {
                performedAt: CONTENT_REVIEWED_AT,
                tool: 'c2patool 0.27.7 (contentauth/c2pa-rs official release)',
                toolArchiveSha256: '2bcb504c67ca6c42fb1ff9fc10ec3ab4dff141902bccca5cd7a88aaee64e4df7',
                trustListInitialized: true,
                validationState: 'Trusted',
                note: '该字段记录本轮独立 c2patool 验证；本脚本重验 PNG 哈希与嵌入声明，但不内置或分发 c2patool。',
            },
        })
    }
    return records
}

async function auditRuntimeBoundary() {
    const gitignore = await readFile(path.join(auditRoot, '.gitignore'), 'utf8')
    const prepareScript = await readFile(path.join(auditRoot, 'scripts', 'prepare-competition-release.mjs'), 'utf8')
    const backendServer = await readFile(path.join(auditRoot, 'backend', 'src', 'server.ts'), 'utf8')
    const runtimePaths = await readFile(path.join(auditRoot, 'backend', 'src', 'runtime-paths.ts'), 'utf8')
    const gitignoreLines = gitignore.split(/\r?\n/u).map((line) => line.trim())
    const dataGitIgnored = gitignoreLines.includes('data/') || gitignoreLines.includes('/data/')
    const distGitIgnored = gitignoreLines.includes('dist/')
    const releaseIncludesFrontendAssets = prepareScript.includes("'frontend/public'") && prepareScript.includes("'frontend/dist'")
    const releaseExplicitlyIncludesData = /["'](?:data|backend\/data)["']/u.test(prepareScript.match(/const treeEntries\s*=\s*\[[\s\S]*?\]/u)?.[0] ?? '')
    if (!dataGitIgnored || !releaseIncludesFrontendAssets || releaseExplicitlyIncludesData) {
        finding('blocker', 'RELEASE_IMAGE_BOUNDARY_INVALID', null,
            '发布边界必须排除 data 运行时缓存并包含 frontend/public 与 frontend/dist。',
            { dataGitIgnored, distGitIgnored, releaseIncludesFrontendAssets, releaseExplicitlyIncludesData })
    }
    const generatedRouteConfigured = backendServer.includes("prefix: '/uploads/generated/'")
    const appDataDirConfigured = runtimePaths.includes('APP_DATA_DIR') && runtimePaths.includes('uploads')
    if (!generatedRouteConfigured || !appDataDirConfigured) {
        finding('blocker', 'GENERATED_MEDIA_DELIVERY_BOUNDARY_MISSING', null, '后端生成图静态路由或 APP_DATA_DIR 运行时路径边界缺失。')
    }
    return {
        dataGitIgnored,
        distGitIgnored,
        releaseIncludesFrontendAssets,
        releaseExplicitlyIncludesData,
        generatedRouteConfigured,
        appDataDirConfigured,
        releaseContract: 'frontend/public 与最新 frontend/dist 随包；data/uploads 是运行时状态，不随 GitHub/比赛发布包。',
        persistenceRequirement: 'Render 必须给 APP_DATA_DIR 配置持久盘，或在每次新实例/部署后重新生成动态媒体；不得把本机 data 缓存声称为随包资源。',
    }
}

async function auditRuntimeImages() {
    if (releasePackageMode) return { present: false, expectedInReleasePackage: false, files: 0, bytes: 0, decodeFailures: 0 }
    const dataRoot = path.join(auditRoot, 'data')
    if (!(await exists(dataRoot))) return { present: false, expectedInReleasePackage: false, files: 0, bytes: 0, decodeFailures: 0 }
    const files = await imageFilesUnder(dataRoot, new Set(['node_modules']))
    const inventory = await auditImageFiles(files, 'runtime-data-cache', { runtime: true, sampleSize: 96 })
    return {
        present: true,
        expectedInReleasePackage: false,
        files: inventory.files.length,
        bytes: inventory.files.reduce((total, asset) => total + asset.bytes, 0),
        decodeFailures: inventory.files.filter((asset) => asset.decodeError).length,
        exactDuplicateGroups: inventory.duplicateGroups,
        assets: inventory.files,
        boundary: '本机运行时缓存，仅用于来源复核和动态服务；Git/发布包明确排除。',
    }
}

async function auditReleaseContamination() {
    const roots = releasePackageMode
        ? [auditRoot]
        : [
            path.join(auditRoot, 'frontend', 'public'),
            path.join(auditRoot, 'frontend', 'dist'),
            path.join(auditRoot, 'evidence'),
            path.join(auditRoot, 'docs', 'audit'),
            path.join(auditRoot, '提交材料'),
        ]
    const files = []
    for (const root of roots) files.push(...await imageFilesUnder(root, releasePackageMode ? new Set(['node_modules', '.git']) : SOURCE_SKIP_DIRECTORIES))
    const unique = [...new Set(files.map((file) => path.resolve(file)))]
    const contaminated = unique.filter((file) => {
        const relative = toRelative(file)
        const segments = relative.split('/')
        return segments.some((segment) => RELEASE_FORBIDDEN_SEGMENTS.has(segment)) || SUSPICIOUS_IMAGE_NAME.test(path.basename(file))
    }).map(toRelative)
    if (contaminated.length > 0) {
        for (const file of contaminated) finding('blocker', 'RELEASE_IMAGE_CONTAMINATION', file, '发布范围含截图、测试夹具、graphify、私密命名或运行时 data 图像。')
    }
    return { scannedImages: unique.length, contaminated }
}

async function trackedInputFiles(paths) {
    const records = []
    for (const relative of [...new Set(paths)].sort((left, right) => left.localeCompare(right, 'zh-CN'))) {
        const file = path.join(auditRoot, relative)
        if (await exists(file)) records.push({ path: relative, sha256: await sha256File(file), bytes: (await stat(file)).size })
    }
    return records
}

function renderMarkdown(report) {
    const lines = [
        '# 图像资产与发布真实性审计',
        '',
        `- 生成时间：${report.generatedAt}`,
        `- 模式：${report.mode}`,
        `- 门禁：${report.gate}`,
        `- 源产品图：${report.summary.sourceProductImages}`,
        `- dist 图：${report.summary.distImages}`,
        `- 精选发布 WebP：${report.summary.curatedReleaseWebp}/${CURATED_IMAGES.length}`,
        `- 阻断：${report.summary.blockers}`,
        `- 警告：${report.summary.warnings}`,
        '',
        '## 原尺寸逐字复核通过的发布 WebP',
        '',
        ...report.curatedReleaseImages.assets.map((item) => {
            const review = item.contentReview.visibleTextReview
            const visible = review.visibleText.length > 0 ? review.visibleText.join('；') : '未发现可辨文字'
            return `- \`${item.id}\` ${item.title}：SHA-256 \`${item.publishedSha256}\`；${item.decode.width}×${item.decode.height} ${item.decode.format}；alpha=${item.decode.hasAlpha}；${review.comparison}；${visible}`
        }),
        '',
        '## 已拒绝的运行时候选',
        '',
        ...report.rejectedRuntimeCandidates.map((item) => `- \`${item.id}\`：${item.code}；源 SHA-256 \`${item.sha256}\`；${item.reason}；兜底 \`${item.fallbackUrl}\`（${item.fallbackAsset?.decodeStatus ?? 'missing'}，SHA-256 \`${item.fallbackAsset?.sha256 ?? 'missing'}\`）`),
        '',
        '## 发布边界',
        '',
        `- 唯一生产映射：${report.releaseMapping.entries.length}/${report.summary.curatedReleaseWebp}；运行时缓存引用：${report.summary.productionRuntimeStarmapReferences}；发布污染：${report.summary.releaseContamination}。`,
        `- public/dist 同源：${report.distParity.status}；缺失 ${report.distParity.missing.length}；不一致 ${report.distParity.mismatched.length}；多余 ${report.distParity.untracked.length}。`,
        `- img alt：总计 ${report.references.imageTags.total}；缺失 ${report.references.imageTags.missingAlt.length}；空 alt ${report.references.imageTags.emptyAlt.length}；无可接受装饰语义 ${report.references.imageTags.emptyAltWithoutAcceptedSemantics.length}。`,
        `- ${report.runtimeBoundary.releaseContract}`,
        `- ${report.runtimeBoundary.persistenceRequirement}`,
        '',
        '## Findings',
        '',
        ...(report.findings.length > 0
            ? report.findings.map((item) => `- [${item.severity}] ${item.code}${item.file ? ` — \`${item.file}\`` : ''}：${item.message}`)
            : ['- 无。']),
        '',
    ]
    return lines.join('\n')
}

async function main() {
    const requiredRoots = ['frontend/public', 'frontend/src', 'frontend/dist', 'backend/src', 'scripts']
    for (const relative of requiredRoots) {
        if (!(await exists(path.join(auditRoot, relative)))) throw new Error(`审计根目录缺少必需路径：${relative}`)
    }

    const publicPaths = await imageFilesUnder(path.join(auditRoot, 'frontend', 'public'))
    const sourcePaths = await imageFilesUnder(path.join(auditRoot, 'frontend', 'src'))
    const distPaths = await imageFilesUnder(path.join(auditRoot, 'frontend', 'dist'))
    const [publicInventory, sourceInventory, distInventory] = await Promise.all([
        auditImageFiles(publicPaths, 'frontend-public'),
        auditImageFiles(sourcePaths, 'frontend-src'),
        auditImageFiles(distPaths, 'frontend-dist'),
    ])
    const duplicateAcrossProductSource = [...groupBy([...publicInventory.files, ...sourceInventory.files], (asset) => asset.sha256).entries()]
        .filter(([, group]) => group.length > 1)
        .map(([sha256, group]) => ({ sha256, files: group.map((asset) => asset.path) }))
    for (const group of duplicateAcrossProductSource) {
        finding('warning', 'DUPLICATE_PRODUCT_SOURCE_IMAGE', group.files[0], 'public/src 中存在字节重复图像。', group)
    }

    const releaseMapping = await auditReleaseMapping()
    const references = await scanFrontendReferences()
    const curated = await auditCuratedImages(publicInventory)
    const rejectedRuntimeCandidates = await auditRejectedCandidates()
    const distParity = await comparePublicAndDist(publicInventory, sourceInventory, distInventory)
    const heroC2paProvenance = await auditHeroProvenance(publicInventory)
    const runtimeBoundary = await auditRuntimeBoundary()
    const runtimeImages = await auditRuntimeImages()
    const releaseContamination = await auditReleaseContamination()

    const tracked = await trackedInputFiles([
        '.gitignore',
        'frontend/vite.config.ts',
        'frontend/src/lib/poem-generated-images.ts',
        'frontend/src/lib/poem-images.ts',
        'frontend/src/lib/poem-image-release-boundary.test.ts',
        'frontend/src/lib/demo-lesson-plan.ts',
        'frontend/src/lib/demo-culture.ts',
        'frontend/src/components/ui/MagicBento.tsx',
        'frontend/src/components/ui/SphereGallery.tsx',
        'frontend/src/pages/AICopilotPage/AttachmentTray.tsx',
        'frontend/src/pages/CultureContextPage/CultureContextPage.tsx',
        'frontend/src/pages/ThinkingPalacePage/PoemImageGenerator.tsx',
        'frontend/src/pages/WorkbenchPage/WorkbenchPage.tsx',
        'scripts/audit-image-assets.mjs',
        'scripts/competition-preflight.mjs',
        'scripts/prepare-competition-release.mjs',
        ...publicInventory.files.map((asset) => asset.path),
        ...sourceInventory.files.map((asset) => asset.path),
        ...distInventory.files.map((asset) => asset.path),
    ])
    const blockers = findings.filter((item) => item.severity === 'blocker').length
    const warnings = findings.filter((item) => item.severity === 'warning').length
    const report = {
        schemaVersion: 3,
        generatedAt: new Date().toISOString(),
        auditRoot: releasePackageMode ? '<release-package>' : auditRoot,
        mode: releasePackageMode ? 'release-package' : 'source-and-build',
        gate: blockers === 0 ? 'PASS' : 'FAIL',
        status: blockers === 0 ? (warnings > 0 ? 'passed_with_warnings' : 'passed') : 'failed',
        summary: {
            sourceProductImages: publicInventory.files.length + sourceInventory.files.length,
            publicImages: publicInventory.files.length,
            sourceImportedImages: sourceInventory.files.length,
            distImages: distInventory.files.length,
            curatedReleaseWebp: curated.count,
            rejectedRuntimeCandidates: rejectedRuntimeCandidates.length,
            runtimeCacheImages: runtimeImages.files,
            runtimeCacheBytes: runtimeImages.bytes,
            productionRuntimeStarmapReferences: references.productionRuntimeStarmapReferences.length,
            productionSvgReferences: references.productionSvgReferences.length,
            releaseContamination: releaseContamination.contaminated.length,
            blockers,
            warnings,
        },
        sourceInventory: {
            public: publicInventory,
            imported: sourceInventory,
            duplicateAcrossProductSource,
        },
        distInventory,
        distParity,
        releaseMapping,
        references,
        curatedReleaseImages: curated,
        rejectedRuntimeCandidates,
        heroC2paProvenance,
        provenanceBoundary: {
            rasterTraceability: `${CURATED_IMAGES.length} 张精选 WebP 完成来源、SHA-256、解码、原尺寸内容与可见文字复核；其中 16 张追溯到既有 starmap manifest，6 张记录 built-in image_gen C2PA 源 PNG 哈希和确定性 WebP 转换；2 张核心 PNG 保留 C2PA caBX 与 OpenAI 生成声明。`,
            svgSafety: '正式诗篇与文化场景映射不得使用 SVG；旧 SVG URL 仅在兼容函数中重写为已审计 WebP。',
            ownershipAttestation: 'AI 输出的最终参赛分发权仍须项目负责人按比赛规则书面确认；自动审计不能替代权属证明。',
            transformations: '既有 16 张 WebP 是缓存源的字节级副本；新增 6 张由 1672×941 C2PA PNG 居中裁切并压缩为 1280×720 WebP quality 90，源/发布哈希均固化；两张 C2PA PNG 未重压缩。',
        },
        runtimeBoundary,
        runtimeImages,
        releaseContamination,
        trackedInputFiles: tracked,
        externalCanaryBoundary: {
            remoteImageReferencesFound: references.remoteReferences.length,
            remoteChecksPerformed: checkRemote,
            staticDeploymentCanaries: [
                { path: '/images/generated/starmap/tongbian-003.webp', expect: 'HTTP 200; Content-Type image/webp; 640x360' },
                { path: '/images/generated/starmap/tongbian-036-v2.webp', expect: 'HTTP 200; Content-Type image/webp; 1280x720; no text or watermark' },
                { path: '/images/generated/starmap/tongbian-007-v2.webp', expect: 'HTTP 200; Content-Type image/webp; 1280x720; no text or watermark' },
                { path: '/images/generated/starmap/tongbian-011-v2.webp', expect: 'HTTP 200; Content-Type image/webp; 1280x720; no text or watermark' },
                { path: '/images/generated/starmap/tongbian-078-v2.webp', expect: 'HTTP 200; Content-Type image/webp; 1280x720; no text or watermark' },
                { path: '/images/generated/starmap/tongbian-043-v2.webp', expect: 'HTTP 200; Content-Type image/webp; 1280x720; no text or watermark' },
                { path: '/images/generated/starmap/tongbian-s36-v2.webp', expect: 'HTTP 200; Content-Type image/webp; 1280x720; no text or watermark' },
                { path: '/images/generated/culture-context-hero-v1.png', expect: 'HTTP 200; Content-Type image/png; SHA-256 preserved by deployment' },
            ],
            dynamicMediaCanary: '调用一次真实生成接口后验证 /uploads/generated/<key>.webp 在重启/重新部署后的持久性；本静态脚本不启动 Render，也不伪造该外部结论。',
            notProvenLocally: ['Render/CDN 的实际 Content-Type 与缓存头', '持久盘挂载和跨重启保留', '浏览器/CDN 对 C2PA 元数据的传输保真'],
        },
        findings,
    }
    console.log(`Image asset audit: ${report.gate}; public=${report.summary.publicImages}; dist=${report.summary.distImages}; curated=${curated.count}/${CURATED_IMAGES.length}; runtime=${runtimeImages.files}; blockers=${blockers}; warnings=${warnings}`)
    for (const item of findings) console.log(`[${item.severity.toUpperCase()}] ${item.code}${item.file ? ` ${item.file}` : ''}: ${item.message}`)
    if (writeReport) {
        const reportDirectory = path.join(auditRoot, 'docs', 'audit')
        await Promise.all([
            atomicWrite(path.join(reportDirectory, 'image-assets-latest.json'), `${JSON.stringify(report, null, 2)}\n`),
            atomicWrite(path.join(reportDirectory, 'image-assets-latest.md'), renderMarkdown(report)),
        ])
        console.log(`REPORT: ${path.join(reportDirectory, 'image-assets-latest.json')}`)
    }
    process.exitCode = blockers === 0 ? 0 : 1
}

main().catch((error) => {
    console.error(`Image asset audit failed: ${error?.stack ?? error}`)
    process.exitCode = 1
})
