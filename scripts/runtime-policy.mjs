/** Runtime policy shared by deployment, local preflight and production-browser tests. */
export const NODE_ENGINE = '>=24.0.0 <25'
export const REFERENCE_NODE = '24.21.0'
export const PNPM_VERSION = '10.34.5'
export function isSupportedNode(version = process.versions.node) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    return Boolean(match && Number(match[1]) === 24)
}
export function assertSupportedRuntime(context = '应用', version = process.versions.node) {
    if (!isSupportedNode(version)) {
        throw new Error(`${context}要求 Node.js ${NODE_ENGINE}；当前为 ${version}。切换运行时后请重新使用冻结锁文件安装，避免原生模块 ABI 不匹配。`)
    }
    return version
}
