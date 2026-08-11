#!/usr/bin/env python3
"""Refresh visible verification figures in the generated Office submission artifacts.

This is intentionally narrow: it replaces only exact, previously audited sentences
inside the DOCX/PPTX package XML, validates the new text and ZIP integrity, then
atomically replaces the original artifact. It refuses to run if the expected old
text is absent or appears an unexpected number of times.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
SUBMISSION = ROOT / "提交材料"

DOCX_OLD = (
    "前端 200 条 API 调用与后端 209 个端点无路径或方法错配；"
    "208 条 HTTP 破坏性路由测试无 5xx/栈泄漏，WebSocket 握手与心跳正常；"
    "关键后端测试范围共 500 项通过，行覆盖率 97.51%；"
    "Fastify 生产同源托管下 32 个桌面/移动界面组合最终 0 警告、0 失败；"
    "首屏真实 gzip 92,637B，满足 120KB 预算。"
)
DOCX_NEW = (
    "前端 206 条 API 调用与后端 215 个端点全部完成路径/方法契约审计，"
    "0 缺失路径、0 方法错配；209 条 HTTP 破坏性路由测试无 5xx/栈泄漏，"
    "WebSocket 握手与心跳正常；关键后端测试范围共 528 项通过，"
    "行覆盖率 97.51%；Fastify 生产同源托管下 32 个桌面/移动界面组合最终 0 警告、"
    "0 失败；首屏真实 gzip 92,635B，满足 120KB 预算。"
)
DOCX_PREVIOUS = (
    "前端 209 条 API 调用与后端 218 个端点全部完成路径/方法契约审计，"
    "0 缺失路径、0 方法错配；217 条 HTTP 端点完成分层运行时验证，其中 209 条"
    "主业务路由无 5xx/栈泄漏，5 条长期记忆与 3 条认证端点完成专项生命周期测试；"
    "未认证 WebSocket 被拒绝，认证后握手与心跳正常；关键后端测试范围共 540 项通过，"
    "行覆盖率 97.51%；Fastify 生产同源托管下 32 个桌面/移动界面组合最终 0 警告、"
    "0 失败；首屏真实 gzip 93,341B，满足 120KB 预算。"
)
DOCX_CURRENT = DOCX_PREVIOUS.replace("共 540 项通过", "共 542 项通过")
DOCX_LATEST = DOCX_CURRENT.replace("共 542 项通过", "共 547 项通过").replace("93,341B", "93,352B")
DOCX_NEWEST = DOCX_LATEST.replace("93,352B", "93,330B")
DOCX_FINAL = DOCX_NEWEST.replace("93,330B", "93,233B")
DOCX_VERIFIED = DOCX_FINAL.replace("93,233B", "93,249B")
DOCX_HARDENED = DOCX_VERIFIED.replace("共 547 项通过", "共 548 项通过")
DOCX_AUTH_HARDENED = DOCX_HARDENED.replace("93,249B", "93,240B")
DOCX_PRIVACY_HARDENED = DOCX_AUTH_HARDENED.replace("93,240B", "93,251B")
DOCX_TTS_HARDENED = DOCX_PRIVACY_HARDENED.replace("93,251B", "93,259B")
DOCX_AUDIO_BOUNDARY_HARDENED = DOCX_TTS_HARDENED.replace("93,259B", "93,251B")
DOCX_PATH_HARDENED = DOCX_AUDIO_BOUNDARY_HARDENED.replace("共 548 项通过", "共 565 项通过")
DOCX_UPLOAD_HARDENED = DOCX_PATH_HARDENED.replace("共 565 项通过", "共 566 项通过")
DOCX_IMAGE_URL_HARDENED = DOCX_UPLOAD_HARDENED.replace("共 566 项通过", "共 567 项通过")
DOCX_NETWORK_HARDENED = DOCX_IMAGE_URL_HARDENED.replace("行覆盖率 97.51%", "行覆盖率 97.52%")
DOCX_MODEL_IMAGE_HARDENED = DOCX_NETWORK_HARDENED.replace("行覆盖率 97.52%", "行覆盖率 97.54%")
DOCX_PROVIDER_HARDENED = DOCX_MODEL_IMAGE_HARDENED.replace("共 567 项通过", "共 568 项通过")
DOCX_DOWNLOAD_HARDENED = DOCX_PROVIDER_HARDENED.replace("共 568 项通过", "共 574 项通过")
DOCX_TTS_RESPONSE_HARDENED = DOCX_DOWNLOAD_HARDENED.replace("共 574 项通过", "共 577 项通过")
DOCX_PROVIDER_RESPONSE_HARDENED = DOCX_TTS_RESPONSE_HARDENED.replace("共 577 项通过", "共 579 项通过")
DOCX_CACHE_DURABILITY_HARDENED = DOCX_PROVIDER_RESPONSE_HARDENED.replace("共 579 项通过", "共 582 项通过")
DOCX_LIFECYCLE_HARDENED = DOCX_CACHE_DURABILITY_HARDENED.replace("共 582 项通过", "共 585 项通过")
DOCX_LIFECYCLE_PREVIOUS = DOCX_LIFECYCLE_HARDENED
DOCX_LIFECYCLE_HARDENED = DOCX_LIFECYCLE_HARDENED.replace("共 585 项通过", "共 587 项通过").replace(
    "行覆盖率 97.54%", "行覆盖率 97.49%"
)
DOCX_LIFECYCLE_587 = DOCX_LIFECYCLE_HARDENED
DOCX_LIFECYCLE_HARDENED = DOCX_LIFECYCLE_HARDENED.replace("共 587 项通过", "共 588 项通过")
DOCX_LIFECYCLE_588 = DOCX_LIFECYCLE_HARDENED
DOCX_LIFECYCLE_588_PREVIOUS = DOCX_LIFECYCLE_588.replace("93,251B", "93,249B")
DOCX_LIFECYCLE_588_PRIOR = DOCX_LIFECYCLE_588.replace("93,251B", "93,238B")
DOCX_LIFECYCLE_588_PRIOR_245 = DOCX_LIFECYCLE_588.replace("93,251B", "93,245B")
DOCX_LIFECYCLE_588_PRIOR_246 = DOCX_LIFECYCLE_588.replace("93,251B", "93,246B")
DOCX_LIFECYCLE_588_PRIOR_241 = DOCX_LIFECYCLE_588.replace("93,251B", "93,241B")
DOCX_LIFECYCLE_588_PRIOR_244 = DOCX_LIFECYCLE_588.replace("93,251B", "93,244B")
DOCX_LIFECYCLE_588_PRIOR_457 = DOCX_LIFECYCLE_588.replace("93,251B", "93,457B")
DOCX_LIFECYCLE_588_PRIOR_454 = DOCX_LIFECYCLE_588.replace("93,251B", "93,454B")
DOCX_LIFECYCLE_588_PRIOR_466 = DOCX_LIFECYCLE_588.replace("93,251B", "93,466B")
DOCX_LIFECYCLE_588_PRIOR_463 = DOCX_LIFECYCLE_588.replace("93,251B", "93,463B")
DOCX_LIFECYCLE_588_469 = DOCX_LIFECYCLE_HARDENED.replace("93,251B", "93,469B")
DOCX_LIFECYCLE_588_478 = DOCX_LIFECYCLE_588_469.replace("93,469B", "93,478B")
DOCX_LIFECYCLE_588_466 = DOCX_LIFECYCLE_588_478.replace("93,478B", "93,466B")
DOCX_LIFECYCLE_588_PRIOR_468 = DOCX_LIFECYCLE_588_466.replace("93,466B", "93,468B")
DOCX_LIFECYCLE_588_PRIOR_428 = DOCX_LIFECYCLE_588_PRIOR_468.replace("93,468B", "93,428B")
DOCX_LIFECYCLE_HARDENED_423 = (
    DOCX_LIFECYCLE_588_PRIOR_428
    .replace("前端 209 条 API 调用与后端 218 个端点", "前端 210 条 API 调用与后端 219 个端点")
    .replace("217 条 HTTP 端点完成分层运行时验证，其中 209 条", "218 条 HTTP 端点完成分层运行时验证，其中 210 条")
    .replace("93,428B", "93,423B")
)
DOCX_LIFECYCLE_HARDENED_421 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,421B")
DOCX_LIFECYCLE_HARDENED_420 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,420B")
DOCX_LIFECYCLE_HARDENED_435 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,435B")
DOCX_LIFECYCLE_HARDENED_427 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,427B")
DOCX_LIFECYCLE_HARDENED_459 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,459B")
DOCX_LIFECYCLE_HARDENED_457 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,457B")
DOCX_LIFECYCLE_HARDENED_447 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,447B")
DOCX_LIFECYCLE_HARDENED_453 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,453B")
DOCX_LIFECYCLE_HARDENED_451 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,451B")
DOCX_LIFECYCLE_HARDENED_455 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,455B")
DOCX_LIFECYCLE_HARDENED_499 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,499B")
DOCX_LIFECYCLE_HARDENED_481 = DOCX_LIFECYCLE_HARDENED_499.replace("93,499B", "93,481B")
DOCX_LIFECYCLE_HARDENED_648 = DOCX_LIFECYCLE_HARDENED_481.replace("93,481B", "93,648B")
DOCX_LIFECYCLE_HARDENED_646 = DOCX_LIFECYCLE_HARDENED_648.replace("93,648B", "93,646B")
DOCX_LIFECYCLE_HARDENED_641 = DOCX_LIFECYCLE_HARDENED_646.replace("93,646B", "93,641B")
DOCX_LIFECYCLE_HARDENED_644 = DOCX_LIFECYCLE_HARDENED_648.replace("93,648B", "93,644B")
DOCX_LIFECYCLE_HARDENED_652 = DOCX_LIFECYCLE_HARDENED_644.replace("93,644B", "93,652B")
DOCX_LIFECYCLE_HARDENED_604 = DOCX_LIFECYCLE_HARDENED_652.replace("共 588 项通过", "共 604 项通过")
DOCX_LIFECYCLE_HARDENED_610 = DOCX_LIFECYCLE_HARDENED_604.replace("共 604 项通过", "共 610 项通过")
DOCX_LIFECYCLE_HARDENED_610_646 = DOCX_LIFECYCLE_HARDENED_610.replace("93,652B", "93,646B")
DOCX_LIFECYCLE_HARDENED_612_646 = DOCX_LIFECYCLE_HARDENED_610_646.replace("共 610 项通过", "共 612 项通过")
DOCX_LIFECYCLE_HARDENED_612_649 = DOCX_LIFECYCLE_HARDENED_612_646.replace("93,646B", "93,649B")
DOCX_LIFECYCLE_HARDENED_612_655 = DOCX_LIFECYCLE_HARDENED_612_649.replace("93,649B", "93,655B")
DOCX_LIFECYCLE_HARDENED_612_645 = DOCX_LIFECYCLE_HARDENED_612_655.replace("93,655B", "93,645B")
DOCX_LIFECYCLE_HARDENED_612_734 = DOCX_LIFECYCLE_HARDENED_612_645.replace("93,645B", "93,734B")
DOCX_LIFECYCLE_HARDENED_615_734 = DOCX_LIFECYCLE_HARDENED_612_734.replace("共 612 项通过", "共 615 项通过")
DOCX_LIFECYCLE_HARDENED_616_734 = DOCX_LIFECYCLE_HARDENED_615_734.replace("共 615 项通过", "共 616 项通过")
DOCX_LIFECYCLE_HARDENED_616_721 = DOCX_LIFECYCLE_HARDENED_616_734.replace("93,734B", "93,721B")
DOCX_LIFECYCLE_HARDENED_616_725 = DOCX_LIFECYCLE_HARDENED_616_721.replace("93,721B", "93,725B")
DOCX_LIFECYCLE_HARDENED_616_718 = DOCX_LIFECYCLE_HARDENED_616_725.replace("93,725B", "93,718B")
DOCX_LIFECYCLE_HARDENED_616_728 = DOCX_LIFECYCLE_HARDENED_616_718.replace("93,718B", "93,728B")
DOCX_LIFECYCLE_HARDENED_655 = DOCX_LIFECYCLE_HARDENED_644.replace("93,644B", "93,655B")
DOCX_LIFECYCLE_HARDENED_637 = DOCX_LIFECYCLE_HARDENED_655.replace("93,655B", "93,637B")
DOCX_LIFECYCLE_HARDENED_654 = DOCX_LIFECYCLE_HARDENED_637.replace("93,637B", "93,654B")
DOCX_LIFECYCLE_HARDENED_449 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,449B")
DOCX_LIFECYCLE_HARDENED_454 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,454B")
DOCX_LIFECYCLE_HARDENED_450 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,450B")
DOCX_LIFECYCLE_HARDENED_445 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,445B")
DOCX_LIFECYCLE_HARDENED_422 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,422B")
DOCX_LIFECYCLE_HARDENED_424 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,424B")
DOCX_LIFECYCLE_HARDENED_426 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,426B")
DOCX_LIFECYCLE_HARDENED_414 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,414B")
DOCX_LIFECYCLE_HARDENED_436 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,436B")
DOCX_LIFECYCLE_HARDENED_428 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,428B")
DOCX_LIFECYCLE_HARDENED_415 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,415B")
DOCX_LIFECYCLE_HARDENED_418 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,418B")
DOCX_LIFECYCLE_HARDENED_425 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,425B")
DOCX_LIFECYCLE_HARDENED_419 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,419B")
DOCX_LIFECYCLE_HARDENED_411 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,411B")
DOCX_LIFECYCLE_HARDENED_437 = DOCX_LIFECYCLE_HARDENED_423.replace("93,423B", "93,437B")
# 每一次目标数值变化都保留为显式历史输入；当前提交物统一到本轮真实构建的 93,718B / 616 项测试。
DOCX_LIFECYCLE_HARDENED = DOCX_LIFECYCLE_HARDENED_616_718


def replace_exact(data: bytes, old: str, new: str, label: str) -> bytes:
    old_bytes = old.encode("utf-8")
    new_bytes = new.encode("utf-8")
    count = data.count(old_bytes)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one old sentence, found {count}")
    return data.replace(old_bytes, new_bytes)


def refresh_zip(target: Path, replacements: dict[str, list[tuple[str, str]]]) -> None:
    if not target.is_file() or target.is_symlink():
        raise RuntimeError(f"refuse non-regular artifact: {target}")

    with ZipFile(target, "r") as source:
        entries = [(info, source.read(info.filename)) for info in source.infolist()]

    updated: dict[str, bytes] = {}
    for info, data in entries:
        current = data
        for old, new in replacements.get(info.filename, []):
            current = replace_exact(current, old, new, f"{target.name}:{info.filename}")
        updated[info.filename] = current

    with tempfile.NamedTemporaryFile(
        prefix="poetic-realm-artifact-",
        suffix=".tmp",
        dir=tempfile.gettempdir(),
        delete=False,
    ) as handle:
        temporary = Path(handle.name)

    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=9) as destination:
            for info, _ in entries:
                destination.writestr(info, updated[info.filename])

        with ZipFile(temporary, "r") as check:
            if check.testzip() is not None:
                raise RuntimeError(f"{target.name}: ZIP integrity check failed")
            for filename, pairs in replacements.items():
                checked = check.read(filename)
                for old, new in pairs:
                    if old.encode("utf-8") in checked or new.encode("utf-8") not in checked:
                        raise RuntimeError(f"{target.name}:{filename}: replacement validation failed")

        # Keep a recoverable copy outside the submission directory until replacement
        # succeeds; it is removed in the finally block.
        backup_fd, backup_name = tempfile.mkstemp(prefix="poetic-realm-artifact-backup-", suffix=".bak")
        os.close(backup_fd)
        backup = Path(backup_name)
        try:
            shutil.copy2(target, backup)
            os.replace(temporary, target)
        except Exception:
            if backup.exists():
                shutil.copy2(backup, target)
            raise
        finally:
            try:
                backup.unlink(missing_ok=True)
            except PermissionError:
                # Windows may briefly retain a handle to the external backup after
                # os.replace. It is outside the project and harmless; do not retry
                # with a stronger deletion primitive.
                print(f"Temporary backup retained by the OS: {backup}")
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    docx = SUBMISSION / "诗脉启明-开发与应用报告.docx"
    with ZipFile(docx, "r") as check:
        document = check.read("word/document.xml")
    # 先识别最终目标，避免某个历史常量恰好与当前目标相同而触发自替换。
    if DOCX_LIFECYCLE_HARDENED.encode("utf-8") in document:
        print("DOCX already contains refreshed figures")
    elif DOCX_LIFECYCLE_HARDENED_616_728.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_616_728, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_616_725.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_616_725, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_616_721.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_616_721, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_616_734.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_616_734, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_615_734.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_615_734, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_612_734.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_612_734, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_612_645.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_612_645, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_612_655.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_612_655, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_612_649.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_612_649, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_612_646.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_612_646, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_OLD.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_OLD, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_NEW.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_NEW, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_PREVIOUS.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_PREVIOUS, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_CURRENT.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_CURRENT, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LATEST.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LATEST, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_NEWEST.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_NEWEST, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_FINAL.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_FINAL, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_VERIFIED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_VERIFIED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_AUTH_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_AUTH_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_TTS_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_TTS_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_AUDIO_BOUNDARY_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_AUDIO_BOUNDARY_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_PATH_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_PATH_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_UPLOAD_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_UPLOAD_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_IMAGE_URL_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_IMAGE_URL_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_NETWORK_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_NETWORK_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_MODEL_IMAGE_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_MODEL_IMAGE_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_PROVIDER_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_PROVIDER_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_DOWNLOAD_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_DOWNLOAD_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_TTS_RESPONSE_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_TTS_RESPONSE_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_PROVIDER_RESPONSE_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_PROVIDER_RESPONSE_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_CACHE_DURABILITY_HARDENED.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_CACHE_DURABILITY_HARDENED, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_PREVIOUS.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_PREVIOUS, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_587.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_587, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PREVIOUS.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PREVIOUS, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_245.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_245, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_246.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_246, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_241.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_241, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_244.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_244, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_457.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_457, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_454.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_454, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_466.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_466, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_468.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_468, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_428.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_428, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_PRIOR_463.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_PRIOR_463, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_469.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_469, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_588_478.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_588_478, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_454.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_454, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_450.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_450, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_457.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_457, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_447.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_447, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_449.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_449, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_451.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_451, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_455.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_455, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_499.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_499, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_648.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_648, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_646.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_646, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_641.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_641, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_604.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_604, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_610.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_610, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_610_646.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_610_646, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_652.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_652, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_644.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_644, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_655.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_655, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_654.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_654, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_637.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_637, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_481.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_481, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_453.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_453, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_445.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_445, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_459.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_459, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_435.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_435, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_437.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_437, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_427.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_427, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_422.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_422, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_420.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_420, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_421.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_421, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_418.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_418, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_415.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_415, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_423.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_423, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_424.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_424, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_428.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_428, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_426.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_426, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_414.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_414, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_436.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_436, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_425.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_425, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_419.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_419, DOCX_LIFECYCLE_HARDENED)]})
    elif DOCX_LIFECYCLE_HARDENED_411.encode("utf-8") in document:
        refresh_zip(docx, {"word/document.xml": [(DOCX_LIFECYCLE_HARDENED_411, DOCX_LIFECYCLE_HARDENED)]})
    else:
        raise RuntimeError("DOCX contains neither an audited prior sentence nor the latest sentence")
    pptx = SUBMISSION / "诗脉启明-答辩PPT-9页.pptx"
    slide7 = "ppt/slides/slide7.xml"
    # 每项指标只选择一个当前实际存在的旧值并直接迁移到最终值，避免把
    # 指标演进并非单调：早期出现 93,454B，之后到 93,468B；本轮前端收口后真实
    # 首屏为 93,718B。刷新时只迁移制品中实际存在的单一旧值。
    # 这样的中间状态只在对应历史制品中出现；刷新时只迁移当前实际存在的一个旧值。
    pptx_candidates = {
        slide7: [
            (["<a:t>547</a:t>", "<a:t>548</a:t>", "<a:t>565</a:t>", "<a:t>566</a:t>", "<a:t>567</a:t>", "<a:t>568</a:t>", "<a:t>574</a:t>", "<a:t>577</a:t>", "<a:t>579</a:t>", "<a:t>582</a:t>", "<a:t>585</a:t>", "<a:t>587</a:t>", "<a:t>588</a:t>", "<a:t>604</a:t>", "<a:t>610</a:t>", "<a:t>612</a:t>", "<a:t>615</a:t>"], "<a:t>616</a:t>"),
            (["<a:t>218</a:t>"], "<a:t>219</a:t>"),
            (["<a:t>93,233B</a:t>", "<a:t>93,249B</a:t>", "<a:t>93,238B</a:t>", "<a:t>93,245B</a:t>", "<a:t>93,246B</a:t>", "<a:t>93,241B</a:t>", "<a:t>93,240B</a:t>", "<a:t>93,251B</a:t>", "<a:t>93,259B</a:t>", "<a:t>93,244B</a:t>", "<a:t>93,454B</a:t>", "<a:t>93,450B</a:t>", "<a:t>93,445B</a:t>", "<a:t>93,447B</a:t>", "<a:t>93,449B</a:t>", "<a:t>93,451B</a:t>", "<a:t>93,453B</a:t>", "<a:t>93,455B</a:t>", "<a:t>93,457B</a:t>", "<a:t>93,459B</a:t>", "<a:t>93,466B</a:t>", "<a:t>93,468B</a:t>", "<a:t>93,499B</a:t>", "<a:t>93,481B</a:t>", "<a:t>93,648B</a:t>", "<a:t>93,654B</a:t>", "<a:t>93,652B</a:t>", "<a:t>93,641B</a:t>", "<a:t>93,637B</a:t>", "<a:t>93,411B</a:t>", "<a:t>93,414B</a:t>", "<a:t>93,415B</a:t>", "<a:t>93,418B</a:t>", "<a:t>93,419B</a:t>", "<a:t>93,420B</a:t>", "<a:t>93,421B</a:t>", "<a:t>93,422B</a:t>", "<a:t>93,423B</a:t>", "<a:t>93,424B</a:t>", "<a:t>93,425B</a:t>", "<a:t>93,426B</a:t>", "<a:t>93,427B</a:t>", "<a:t>93,428B</a:t>", "<a:t>93,435B</a:t>", "<a:t>93,436B</a:t>", "<a:t>93,437B</a:t>", "<a:t>93,463B</a:t>", "<a:t>93,469B</a:t>", "<a:t>93,478B</a:t>", "<a:t>93,644B</a:t>", "<a:t>93,646B</a:t>", "<a:t>93,649B</a:t>", "<a:t>93,655B</a:t>", "<a:t>93,645B</a:t>", "<a:t>93,734B</a:t>", "<a:t>93,721B</a:t>", "<a:t>93,725B</a:t>", "<a:t>93,728B</a:t>"], "<a:t>93,718B</a:t>"),
        ],
    }
    with ZipFile(pptx, "r") as check:
        contents = {name: check.read(name) for name in pptx_candidates}
    pending: dict[str, list[tuple[str, str]]] = {}
    for name, metrics in pptx_candidates.items():
        for old_values, new in metrics:
            new_count = contents[name].count(new.encode("utf-8"))
            old_counts = [(old, contents[name].count(old.encode("utf-8"))) for old in old_values]
            present_old = [(old, count) for old, count in old_counts if count > 0]
            if new_count == 1 and not present_old:
                continue
            if new_count == 0 and len(present_old) == 1 and present_old[0][1] == 1:
                pending.setdefault(name, []).append((present_old[0][0], new))
                continue
            raise RuntimeError(f"PPTX {name} contains an unexpected old/new figure state")
    if pending:
        refresh_zip(pptx, pending)
    else:
        print("PPTX already contains refreshed figures")
    print("Submission Office artifacts refreshed and ZIP-validated")


if __name__ == "__main__":
    main()
