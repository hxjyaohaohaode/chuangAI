/**
 * 智能批改台扩展图标注册（Task 12）
 *
 * 通过 Icon 组件的 registerIcons 扩展机制注入业务图标，
 * 不修改基础 Icon.tsx 组件（遵循"不修改基础组件"约束）。
 *
 * 注册图标：
 * - upload        上传
 * - camera        相机
 * - file-image    图片文件
 * - paper-plane   发送
 * - image         图片
 * - clipboard     剪贴板（粘贴提示）
 * - check-square  审核确认
 * - pencil-line   修正
 * - bookmark      标记参考
 */

import {
    UploadSimple,
    Camera,
    FileImage,
    PaperPlaneTilt,
    Image as ImageIcon,
    Clipboard,
    CheckSquare,
    PencilLine,
    Bookmark,
} from '@phosphor-icons/react'
import { registerIcons } from '@/components/ui'

let registered = false

/**
 * 注册智能批改台所需图标（幂等，多次调用安全）
 */
export function registerGradingIcons(): void {
    if (registered) return
    registerIcons({
        upload: UploadSimple,
        camera: Camera,
        'file-image': FileImage,
        'paper-plane': PaperPlaneTilt,
        image: ImageIcon,
        clipboard: Clipboard,
        'check-square': CheckSquare,
        'pencil-line': PencilLine,
        bookmark: Bookmark,
    })
    registered = true
}
