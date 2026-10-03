"""Offline Phase 2 Vault reader, context compiler, and guarded note writer.

Only explicit local Markdown paths are read. This module never invokes a model,
network service, Obsidian process, or the existing ebi-team runtime.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
from dataclasses import dataclass
from datetime import date
import hashlib
import json
import marshal
import os
from pathlib import Path
import re
import sys
import tempfile

_LOADED_MODULE_CODE_SHA = hashlib.sha256(marshal.dumps(sys._getframe().f_code)).hexdigest()
_LOADED_SOURCE_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

COMPILER_VERSION = "phase2-3"
DIRECTORIES = (
    "00_System", "10_Projects", "20_Decisions", "30_Patterns", "40_Lessons",
    "50_Policies", "60_Evaluations", "70_Feedback", "80_Tasks", "85_Derived", "90_Archive",
)
KINDS = {"Project", "Spec", "Task", "Lesson", "Decision", "Pattern", "Policy", "Evaluation", "Feedback"}
STATUSES = {"draft", "candidate", "active", "deprecated"}
VERIFICATIONS = {"untested", "observed", "compared", "unknown"}
SENSITIVITIES = {"local", "private"}
LIST_FIELDS = {"source_refs", "depends_on", "supersedes", "tags", "roles", "task_classes", "source_versions"}
SCALAR_FIELDS = {
    "id", "kind", "project", "scope", "status", "version", "updated", "title",
    "summary", "sensitivity", "verification_status", "required", "approval_ref", "task_class",
}
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$")
KEY_PATTERN = re.compile(r"^([a-z_]+):(?:[ \t]*(.*))?$")
MAX_NOTE_BYTES = 2_000_000
PACK_MARKER = "<!-- Negi-Teams derived context pack; source notes remain authoritative -->"


class VaultError(ValueError):
    """Invalid Vault content, unsafe path, or optimistic-write conflict."""


@dataclass(frozen=True)
class Note:
    path: Path
    relative: str
    properties: dict
    body: str
    sha256: str

    @property
    def id(self) -> str:
        return self.properties["id"]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _value(raw: str, path: Path, line_no: int):
    raw = raw.strip()
    if raw == "[]":
        return []
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw.startswith('"'):
        try:
            result = json.loads(raw)
        except json.JSONDecodeError as error:
            raise VaultError(f"{path}:{line_no}: 引用値が不正: {error.msg}") from error
        if not isinstance(result, str):
            raise VaultError(f"{path}:{line_no}: 文字列が必要")
        return result
    if raw.startswith("'") and raw.endswith("'") and len(raw) >= 2:
        return raw[1:-1].replace("''", "'")
    if (not raw or raw in {"null", "~"} or raw.startswith(("{", "[", "&", "*", "!", "|", ">", "#"))
            or ": " in raw or " #" in raw):
        raise VaultError(f"{path}:{line_no}: このProperties形式には非対応")
    return raw


def parse_note(data: bytes, path: Path, relative: str) -> Note:
    if len(data) > MAX_NOTE_BYTES:
        raise VaultError(f"{path}: ノートが{MAX_NOTE_BYTES} bytesを超える")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise VaultError(f"{path}: UTF-8ではない") from error
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise VaultError(f"{path}: YAML Propertiesの開始がない")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise VaultError(f"{path}: YAML Propertiesの終了がない")
    props: dict[str, object] = {}
    current_list: str | None = None
    for index, raw_line in enumerate(lines[1:end], 2):
        line = raw_line.rstrip("\r\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("  - ") and current_list:
            item = _value(line[4:], path, index)
            if not isinstance(item, str) or not item:
                raise VaultError(f"{path}:{index}: リスト要素は文字列にする")
            props[current_list].append(item)
            continue
        match = KEY_PATTERN.fullmatch(line)
        if not match:
            raise VaultError(f"{path}:{index}: 平坦なPropertiesのみ対応")
        key, raw = match.groups()
        if key not in LIST_FIELDS | SCALAR_FIELDS or key in props:
            raise VaultError(f"{path}:{index}: 未対応または重複した項目 {key}")
        if key in LIST_FIELDS and (raw is None or not raw.strip()):
            props[key] = []
            current_list = key
        else:
            props[key] = _value(raw or "", path, index)
            current_list = None
    for key in ("id", "kind", "project", "scope", "status", "version", "updated", "sensitivity"):
        if key not in props or not isinstance(props[key], str):
            raise VaultError(f"{path}: 必須Properties {key} がない")
    for key in LIST_FIELDS:
        props.setdefault(key, [])
        if not isinstance(props[key], list):
            raise VaultError(f"{path}: {key} はブロック形式のリストにする")
    if not ID_PATTERN.fullmatch(props["id"]):
        raise VaultError(f"{path}: id形式が不正")
    if props["kind"] not in KINDS or props["status"] not in STATUSES:
        raise VaultError(f"{path}: kindまたはstatusが不正")
    if not props["version"].isdigit() or int(props["version"]) < 1:
        raise VaultError(f"{path}: versionは正の整数にする")
    try:
        date.fromisoformat(props["updated"])
    except ValueError as error:
        raise VaultError(f"{path}: updatedはYYYY-MM-DDにする") from error
    if props["scope"] not in {"global", "project"}:
        raise VaultError(f"{path}: scopeが不正")
    if (props["scope"] == "global") != (props["project"] == "global"):
        raise VaultError(f"{path}: global scopeとprojectは両方globalにする")
    if props["sensitivity"] not in SENSITIVITIES:
        raise VaultError(f"{path}: sensitivityが不正")
    if props.get("verification_status", "unknown") not in VERIFICATIONS:
        raise VaultError(f"{path}: verification_statusが不正")
    if "required" in props and not isinstance(props["required"], bool):
        raise VaultError(f"{path}: requiredはtrue/falseにする")
    if props.get("required") and props["kind"] not in {"Spec", "Policy", "Project"}:
        raise VaultError(f"{path}: requiredはSpec/Policy/Projectだけに指定する")
    if props["status"] == "active" and props["kind"] in {"Spec", "Task", "Lesson", "Policy"} and not props["source_refs"]:
        raise VaultError(f"{path}: activeな{props['kind']}にはsource_refsが必要")
    for key in LIST_FIELDS:
        if len(props[key]) != len(set(props[key])):
            raise VaultError(f"{path}: {key}に重複がある")
    validate_local_references(props, path)
    if any(role not in {"astra", "sol", "luna"} for role in props["roles"]):
        raise VaultError(f"{path}: rolesが不正")
    if "task_class" in props and (props["kind"] != "Task" or not isinstance(props["task_class"], str) or
                                  not re.fullmatch(r"[a-z][a-z0-9_.-]{0,79}", props["task_class"])):
        raise VaultError(f"{path}: Taskのtask_classが不正")
    if props["task_classes"] or props["source_versions"]:
        if props["kind"] != "Lesson" or props["scope"] != "project" or not props["task_classes"] or \
                not props["source_versions"] or not props["source_refs"]:
            raise VaultError(f"{path}: 条件付きLessonにはproject範囲・task_classes・source_versions・出典が必要")
        if any(not re.fullmatch(r"[a-z][a-z0-9_.-]{0,79}", item) for item in props["task_classes"]) or \
                any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,79}@[1-9][0-9]*:[0-9a-f]{64}", item)
                    for item in props["source_versions"]):
            raise VaultError(f"{path}: Lessonの適用分類または根拠版が不正")
        source_ids = [ref.split("@", 1)[0].casefold() for ref in props["source_versions"]]
        if props["id"].casefold() in source_ids or len(source_ids) != len(set(source_ids)):
            raise VaultError(f"{path}: Lessonの根拠IDが重複または自己参照")
    return Note(path, relative, props, "".join(lines[end + 1:]), sha256(data))


def validate_local_references(properties, path):
    # This input depends on the current filesystem, not the note's byte checksum.
    for reference in properties["source_refs"]:
        local = Path(reference.split("#", 1)[0])
        if local.is_absolute() and not local.is_file():
            raise VaultError(f"{path}: ローカル出典が見つからない: {reference}")


def vault_root(raw: str) -> Path:
    root = Path(raw).expanduser().resolve(strict=True)
    if not root.is_dir() or root.is_symlink():
        raise VaultError("Vaultは実在する通常のディレクトリを指定する")
    return root


def _safe_note_path(root: Path, path: Path) -> bool:
    relative = path.relative_to(root)
    if len(relative.parts) < 2 or relative.parts[0] not in DIRECTORIES:
        return False
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root and root in parent.parents):
        raise VaultError(f"シンボリックリンクのノートは対象外: {path}")
    if not path.resolve(strict=True).is_relative_to(root):
        raise VaultError(f"Vault外への参照: {path}")
    return True


def load_notes(root: Path, cache=None, allow_private: bool = False) -> dict[str, Note]:
    notes: dict[str, Note] = {}
    for path in sorted(root.rglob("*.md")):
        if not _safe_note_path(root, path):
            continue
        if path.stat().st_size > MAX_NOTE_BYTES:
            raise VaultError(f"ノートの上限超過: {path}")
        raw = path.read_bytes()
        relative, checksum = path.relative_to(root).as_posix(), sha256(raw)
        inputs = {"path": relative, "sha256": checksum, "allow_private": allow_private}
        stored = cache.get("l1", inputs) if cache is not None else None
        if (isinstance(stored, dict) and set(stored) == {"properties", "body"} and
                isinstance(stored["properties"], dict) and isinstance(stored["body"], str) and
                isinstance(stored["properties"].get("id"), str)):
            note = Note(path, relative, stored["properties"], stored["body"], checksum)
            validate_local_references(note.properties, path)
        else:
            note = parse_note(raw, path, relative)
            if cache is not None and (allow_private or note.properties["sensitivity"] != "private"):
                cache.put("l1", inputs, {"properties": note.properties, "body": note.body})
        key = note.id.casefold()
        if key in notes:
            raise VaultError(f"ID重複: {note.id} / {notes[key].relative} / {note.relative}")
        notes[key] = note
    return notes


def _eligible(note: Note, project: str, allow_private: bool = False) -> bool:
    return (note.properties["status"] == "active" and
            note.relative.split("/", 1)[0] not in {"85_Derived", "90_Archive"} and
            (allow_private or note.properties["sensitivity"] != "private") and
            (note.properties["project"] == project or note.properties["scope"] == "global"))


def _required_closure(notes: dict[str, Note], seeds: set[str], project: str,
                      allow_private: bool = False, task_class: str | None = None,
                      knowledge_authority=None) -> set[str]:
    selected = set()
    pending = list(seeds)
    while pending:
        key = pending.pop()
        if key in selected:
            continue
        note = notes.get(key)
        if note is None or not _eligible(note, project, allow_private):
            raise VaultError(f"必須または依存IDが未取得・非active・権限外: {key}")
        if not lesson_applies(note, notes, task_class, project, allow_private, knowledge_authority):
            raise VaultError(f"Lessonの適用条件または根拠版が一致しない: {key}")
        selected.add(key)
        pending.extend(ref.casefold() for ref in note.properties["depends_on"])
    return selected


def lesson_applies(note: Note, notes: dict[str, Note], task_class: str | None,
                   project: str, allow_private: bool = False, knowledge_authority=None) -> bool:
    """A classified Lesson is withheld on unknown class, stale sources or revocation."""
    if note.properties["kind"] != "Lesson":
        return True
    if note.properties["status"] == "active":
        if knowledge_authority is not None:
            if not knowledge_authority.allows(note):
                return False
        elif managed_knowledge_note(note):
            return False
    if not note.properties["task_classes"]:
        return True
    if task_class not in note.properties["task_classes"]:
        return False
    for ref in note.properties["source_versions"]:
        source_id, version_hash = ref.split("@", 1)
        version, digest = version_hash.split(":", 1)
        source = notes.get(source_id.casefold())
        if source is None or not _eligible(source, project, allow_private) or \
                source.properties["version"] != version or source.sha256 != digest:
            return False
    return True


def managed_knowledge_note(note: Note) -> bool:
    return (bool(re.fullmatch(r"NT-LESSON-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", note.id, re.I)) or
            str(note.properties.get("approval_ref", "")).startswith("user:http-knowledge:") or
            any(ref.startswith("negi-knowledge:") for ref in note.properties["source_refs"]))


def search_notes(notes: dict[str, Note], project: str, query: str,
                 status: str = "active", allow_private: bool = False) -> list[tuple[int, Note]]:
    words = [word.casefold() for word in query.split() if word]
    if not words:
        return []
    hits = []
    for note in notes.values():
        if (note.relative.split("/", 1)[0] in {"85_Derived", "90_Archive"} or
                not (note.properties["project"] == project or note.properties["scope"] == "global") or
                (not allow_private and note.properties["sensitivity"] == "private") or
                (status != "all" and note.properties["status"] != status)):
            continue
        title = str(note.properties.get("title", "")).casefold()
        meta = " ".join([str(note.properties.get("summary", "")), *note.properties["tags"]]).casefold()
        body = note.body.casefold()
        score = sum(5 * (word in title) + 3 * (word in meta) + (word in body) for word in words)
        if score:
            hits.append((score, note))
    return sorted(hits, key=lambda pair: (-pair[0], pair[1].id))


def _render_pack(notes: dict[str, Note], selected: set[str], mandatory: set[str],
                 project: str, role: str, query: str, task_class: str | None = None) -> str:
    entries = []
    sections = []
    for key in sorted(selected, key=lambda item: (item not in mandatory, notes[item].id)):
        note = notes[key]
        full = key in mandatory or (note.properties["kind"] == "Lesson" and
                                   bool(note.properties["task_classes"]))
        fidelity = "full" if full else "metadata"
        body = note.body.strip() if full else str(note.properties.get("summary", "")).strip()
        if not body:
            body = "（本文はreadコマンドで取得）" if not full else "（本文なし）"
        entries.append({"id": note.id, "kind": note.properties["kind"],
                        "version": int(note.properties["version"]),
                        "sha256": note.sha256, "path": note.relative, "fidelity": fidelity})
        sections.append(f"## {note.id} — {note.properties.get('title', note.path.stem)}\n"
                        f"kind={note.properties['kind']} / status={note.properties['status']} / "
                        f"verification={note.properties.get('verification_status', 'unknown')} / "
                        f"version={note.properties['version']} / sha256={note.sha256}\n"
                        f"source_refs={json.dumps(note.properties['source_refs'], ensure_ascii=False)}\n\n{body}\n")
        if note.properties["kind"] == "Lesson" and note.properties["task_classes"]:
            sections[-1] += (f"\n適用分類: {', '.join(note.properties['task_classes'])}。"
                             "必須Spec/Taskの条件・検証・権限を置き換えない。詳細の非適用条件と反例は正本を参照。\n")
    manifest = {"compiler_version": COMPILER_VERSION, "project": project, "role": role,
                "query": query, "sources": entries,
                "task_class": task_class,
                "policy_versions": {entry["id"]: entry["version"] for entry in entries
                                    if entry["kind"] == "Policy"}}
    pack_id = sha256(json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode())[:20]
    content = (f"{PACK_MARKER}\n# Context Pack {pack_id}\n\n"
               f"project={project} / role={role} / compiler={COMPILER_VERSION}\n"
               "必須ノートは原文。追加の関連ノートはmetadataのみ。正本は各Vaultノート。\n\n"
               + "\n".join(sections))
    estimated_tokens = (len(content) + 3) // 4
    return content + (f"\n<!-- manifest: {json.dumps(manifest, ensure_ascii=False, sort_keys=True)}; "
                      f"estimated_tokens={estimated_tokens} -->\n")


def build_pack(notes: dict[str, Note], project: str, role: str, query: str,
               required_ids: list[str], max_chars: int, allow_private: bool = False,
               task_class: str | None = None, knowledge_authority=None) -> str:
    if role not in {"astra", "sol", "luna"} or max_chars < 1000:
        raise VaultError("roleまたはmax-charsが不正")
    required_notes = [note for note in notes.values()
                      if note.properties["status"] == "active" and
                      (note.properties["project"] == project or note.properties["scope"] == "global") and
                      note.relative.split("/", 1)[0] not in {"85_Derived", "90_Archive"} and
                      note.properties.get("required", False)]
    if not allow_private and any(note.properties["sensitivity"] == "private" for note in required_notes):
        raise VaultError("必須privateノートがある。明示許可なしにPackへ含めない")
    seeds = {note.id.casefold() for note in required_notes}
    seeds.update(item.casefold() for item in required_ids)
    if not seeds:
        raise VaultError("必須ノートがない。--requireかactive/requiredな仕様を指定する")
    if task_class is not None and not re.fullmatch(r"[a-z][a-z0-9_.-]{0,79}", task_class):
        raise VaultError("task-classが不正")
    mandatory = _required_closure(notes, seeds, project, allow_private, task_class, knowledge_authority)
    selected = set(mandatory)
    pack = _render_pack(notes, selected, mandatory, project, role, query, task_class)
    if len(pack) > max_chars:
        raise VaultError("必須ノートだけで上限超過。必須条件を削らず、上限拡大かタスク分割を行う")
    ranked = search_notes(notes, project, query, allow_private=allow_private)
    ranked_ids = {note.id.casefold() for _, note in ranked}
    # An explicitly scoped class is also a retrieval key. Japanese objectives
    # need not contain an identical whitespace-delimited phrase from the Lesson.
    ranked.extend((0, note) for note in sorted(notes.values(), key=lambda item: item.id)
                  if note.id.casefold() not in ranked_ids and _eligible(note, project, allow_private) and
                  note.properties["kind"] == "Lesson" and note.properties["task_classes"] and
                  task_class in note.properties["task_classes"])
    for _score, note in ranked:
        key = note.id.casefold()
        if key in selected:
            continue
        if note.properties["roles"] and role not in note.properties["roles"]:
            continue
        if not lesson_applies(note, notes, task_class, project, allow_private, knowledge_authority):
            continue
        group = _required_closure(notes, {key}, project, allow_private, task_class, knowledge_authority)
        trial_selected = selected | group
        trial_mandatory = mandatory | (group - {key})
        trial = _render_pack(notes, trial_selected, trial_mandatory, project, role, query, task_class)
        if len(trial) <= max_chars:
            selected, mandatory, pack = trial_selected, trial_mandatory, trial
    return pack


def compiler_fingerprint() -> str:
    import negi_knowledge, negi_context_cache, negi_recover_writer
    identities = [(__file__, _LOADED_MODULE_CODE_SHA, _LOADED_SOURCE_SHA),
                  *((module.__file__, module._LOADED_MODULE_CODE_SHA, module._LOADED_SOURCE_SHA)
                    for module in (negi_knowledge, negi_context_cache, negi_recover_writer))]
    # Bind actual loaded module code, not successor bytes edited on disk. Rehashing
    # disk alone could label a running A compiler's output with new B semantics.
    for path, _code, source in identities:
        if sha256(Path(path).read_bytes()) != source:
            raise VaultError("Context Packの処理版が読み込み後に変化した。再起動が必要")
    return sha256(json.dumps({"version": COMPILER_VERSION, "python": sys.version,
        "code": {Path(path).name: code for path, code, _source in identities}},
        sort_keys=True).encode())


def source_fingerprint(root: Path) -> dict[str, str]:
    result = {}
    for path in sorted(root.rglob("*.md")):
        if _safe_note_path(root, path):
            if path.stat().st_size > MAX_NOTE_BYTES:
                raise VaultError(f"ノートの上限超過: {path}")
            result[path.relative_to(root).as_posix()] = sha256(path.read_bytes())
    return result


def authority_fingerprint(authority, notes):
    return {"directory": os.path.normcase(str(authority.directory)) if authority is not None else None,
            "lessons": {key: bool(authority.allows(note)) if authority is not None else not managed_knowledge_note(note)
                        for key, note in sorted(notes.items()) if note.properties["kind"] == "Lesson"}}


def compile_current_pack(root: Path, project: str, role: str, query: str,
                         required_ids: list[str], max_chars: int, allow_private: bool = False,
                         task_class: str | None = None, knowledge_proof_dir: str | None = None,
                         cache_directory: str | None = None):
    """Return exact fresh semantics; a cache can only reuse the same current snapshot."""
    from negi_knowledge import KnowledgeAuthority
    from negi_context_cache import ContextCache, CachePathError, CacheUnavailable, digest
    processor = compiler_fingerprint()
    with ExitStack() as boundary:
        cache = None
        stats = {"enabled": False}
        if cache_directory:
            try:
                cache = boundary.enter_context(ContextCache(cache_directory, root, processor))
                stats = {"enabled": True, "counts": cache.counts}
            except CachePathError as error:
                raise VaultError(str(error)) from error
            except (CacheUnavailable, OSError, ValueError):
                # Partial registration, contention or unsupported OS never promotes
                # old bytes. Sources still undergo the full compilation and fences.
                stats = {"enabled": False, "reason": "unavailable"}
        notes = load_notes(root, cache, allow_private)
        before = {note.relative: note.sha256 for note in notes.values()}
        authority = KnowledgeAuthority(knowledge_proof_dir, root) if knowledge_proof_dir else None
        permissions = authority_fingerprint(authority, notes)
        epoch = digest({"sources": before, "authority": permissions, "processor": processor,
                        "allow_private": allow_private})
        inputs = {"epoch": epoch, "project": project, "role": role, "query": query,
                  "required": sorted({item.casefold() for item in required_ids}), "max_chars": max_chars,
                  "allow_private": allow_private, "task_class": task_class}
        content = cache.get("l2", inputs) if cache is not None else None
        hit = isinstance(content, str) and content.startswith(PACK_MARKER) and len(content) <= max_chars
        if not hit:
            content = build_pack(notes, project, role, query, required_ids, max_chars,
                                 allow_private, task_class, authority)
        # Read current source bytes and verify the signed authority again, including
        # pending revocation where the Vault note has not yet been rewritten.
        after_authority = KnowledgeAuthority(knowledge_proof_dir, root) if knowledge_proof_dir else None
        for note in notes.values():
            validate_local_references(note.properties, note.path)
        if (source_fingerprint(root) != before or compiler_fingerprint() != processor or
                authority_fingerprint(after_authority, notes) != permissions):
            raise VaultError("Context Packの作成中に正本・承認・処理版が変化した。再読が必要")
        if cache is not None:
            try:
                cache.prune(epoch)
                if not hit:
                    cache.put("l2", inputs, content, epoch)
            except (CacheUnavailable, OSError, ValueError):
                stats["maintenance_skipped"] = True
        return content, stats


def _atomic_write(path: Path, data: bytes, before_replace=None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".negi-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if before_replace is not None:
            before_replace()
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


@contextmanager
def _writer_lock(root: Path):
    lock = root / ".negi-writer.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise VaultError(f"別のWriterが稼働中、または停止後のlock要確認: {lock}") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(f"pid={os.getpid()}\n")
            stream.flush()
            os.fsync(stream.fileno())
        yield
    finally:
        lock.unlink(missing_ok=True)


def update_note(root: Path, notes: dict[str, Note], note_id: str,
                replacement: Path, expected_sha: str, approval_ref: str | None = None) -> str:
    note = notes.get(note_id.casefold())
    if note is None:
        raise VaultError(f"IDがない: {note_id}")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        raise VaultError("expected-shaは64文字のSHA-256にする")
    if note.sha256 != expected_sha:
        raise VaultError(f"更新前hashが一致しない: {note_id}")
    data = replacement.read_bytes()
    updated = parse_note(data, note.path, note.relative)
    if updated.id != note.id or int(updated.properties["version"]) <= int(note.properties["version"]):
        raise VaultError("IDを維持し、versionを増やす")
    for key in ("kind", "project", "scope", "sensitivity"):
        if updated.properties[key] != note.properties[key]:
            raise VaultError(f"{key}の変更はこのWriterから行わない")
    if approval_ref is None:
        if updated.properties["status"] != note.properties["status"]:
            raise VaultError("statusの変更は通常のupdateから行わない")
    elif (note.properties["status"] != "candidate" or
          updated.properties["status"] != "active" or
          updated.properties.get("approval_ref") != approval_ref or
          not approval_ref.startswith("user:")):
        raise VaultError("active化にはcandidate、明示したuser承認参照、対応するPropertiesが必要")
    with _writer_lock(root):
        if note.path.is_symlink() or not note.path.resolve(strict=True).is_relative_to(root):
            raise VaultError(f"Vault外への参照: {note.path}")
        def verify_current():
            if note.path.is_symlink() or not note.path.resolve(strict=True).is_relative_to(root):
                raise VaultError(f"Vault外への参照: {note.path}")
            if sha256(note.path.read_bytes()) != expected_sha:
                raise VaultError(f"同時手編集との競合: {note_id}")
        verify_current()
        _atomic_write(note.path, data, verify_current)
    return updated.sha256


def rename_note(root: Path, notes: dict[str, Note], note_id: str,
                filename: str, expected_sha: str) -> str:
    note = notes.get(note_id.casefold())
    if note is None:
        raise VaultError(f"IDがない: {note_id}")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.md", filename):
        raise VaultError("新しい名前は同じフォルダ内の安全な.mdファイル名にする")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha) or note.sha256 != expected_sha:
        raise VaultError(f"更新前hashが一致しない: {note_id}")
    target = note.path.with_name(filename)
    if target == note.path:
        return note.relative
    with _writer_lock(root):
        if note.path.is_symlink() or not note.path.resolve(strict=True).is_relative_to(root):
            raise VaultError(f"Vault外への参照: {note.path}")
        if sha256(note.path.read_bytes()) != expected_sha:
            raise VaultError(f"同時手編集との競合: {note_id}")
        if target.exists() or target.is_symlink():
            raise VaultError(f"移動先が既に存在: {target}")
        os.rename(note.path, target)
    return target.relative_to(root).as_posix()


def create_candidate(root: Path, directory: str, filename: str, source: Path) -> tuple[str, str]:
    """Create a candidate evidence/lesson note without granting it authority."""
    allowed = {"40_Lessons": "Lesson", "60_Evaluations": "Evaluation",
               "70_Feedback": "Feedback"}
    if directory not in allowed or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.md", filename):
        raise VaultError("候補の保存先またはファイル名が不正")
    data = source.read_bytes()
    relative = f"{directory}/{filename}"
    target = root / directory / filename
    candidate = parse_note(data, target, relative)
    if candidate.properties["kind"] != allowed[directory] or candidate.properties["status"] != "candidate":
        raise VaultError("作成できるのは対応するkindのcandidateのみ")
    with _writer_lock(root):
        parent = root / directory
        if parent.is_symlink():
            raise VaultError("シンボリックリンクの保存先は拒否")
        parent.mkdir(exist_ok=True)
        if parent.resolve(strict=True) != root / directory:
            raise VaultError("Vault外への保存を拒否")
        if candidate.id.casefold() in load_notes(root):
            raise VaultError(f"ID重複: {candidate.id}")
        if target.exists() or target.is_symlink():
            raise VaultError("保存先が既に存在")
        descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    return candidate.id, candidate.sha256


def deprecate_note(root: Path, notes: dict[str, Note], note_id: str,
                   replacement: Path, expected_sha: str, reason_ref: str) -> str:
    """Retain the history while removing a note from future active packs."""
    note = notes.get(note_id.casefold())
    if note is None or note.properties["status"] not in {"candidate", "active"}:
        raise VaultError("失効対象はcandidateまたはactiveの既存ノートにする")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha) or note.sha256 != expected_sha:
        raise VaultError("更新前hashが一致しない")
    if not reason_ref.strip():
        raise VaultError("失効理由の参照が必要")
    data = replacement.read_bytes()
    updated = parse_note(data, note.path, note.relative)
    if updated.id != note.id or updated.properties["status"] != "deprecated" or \
            int(updated.properties["version"]) <= int(note.properties["version"]) or \
            reason_ref not in updated.properties["source_refs"] or \
            not set(note.properties["source_refs"]).issubset(updated.properties["source_refs"]):
        raise VaultError("同じIDの新版でdeprecatedと理由参照を記録する")
    for key in ("kind", "project", "scope", "sensitivity"):
        if updated.properties[key] != note.properties[key]:
            raise VaultError(f"{key}の変更は失効操作から行わない")
    with _writer_lock(root):
        if note.path.is_symlink() or not note.path.resolve(strict=True).is_relative_to(root):
            raise VaultError("Vault外のノートは失効できない")
        def verify_current():
            if sha256(note.path.read_bytes()) != expected_sha:
                raise VaultError(f"同時手編集との競合: {note_id}")
        verify_current()
        _atomic_write(note.path, data, verify_current)
    return updated.sha256


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Offline Negi-Teams Vault Phase 2 CLI")
    parser.add_argument("--vault", required=True, help="明示したObsidian Vaultディレクトリ")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate")
    listing = sub.add_parser("search")
    listing.add_argument("--project", required=True)
    listing.add_argument("--query", required=True)
    listing.add_argument("--status", choices=["active", "candidate", "all"], default="active")
    listing.add_argument("--allow-private", action="store_true")
    reading = sub.add_parser("read")
    reading.add_argument("--id", required=True)
    packing = sub.add_parser("pack")
    packing.add_argument("--project", required=True)
    packing.add_argument("--role", required=True, choices=["astra", "sol", "luna"])
    packing.add_argument("--query", default="")
    packing.add_argument("--require", action="append", default=[])
    packing.add_argument("--max-chars", type=int, default=16000)
    packing.add_argument("--allow-private", action="store_true")
    packing.add_argument("--task-class")
    packing.add_argument("--knowledge-proof-dir")
    packing.add_argument("--cache-dir", help="Vault外のローカル派生cache（Windows。破損時は正本から再作成）")
    packing.add_argument("--cache-stats", action="store_true", help="本文を含めないcache計数をstderrへ出力")
    pack_destination = packing.add_mutually_exclusive_group(required=True)
    pack_destination.add_argument("--out")
    pack_destination.add_argument("--stdout", action="store_true")
    updating = sub.add_parser("update")
    updating.add_argument("--id", required=True)
    updating.add_argument("--from-file", required=True)
    updating.add_argument("--expected-sha", required=True)
    activation = sub.add_parser("activate")
    activation.add_argument("--id", required=True)
    activation.add_argument("--from-file", required=True)
    activation.add_argument("--expected-sha", required=True)
    activation.add_argument("--approval-ref", required=True)
    renaming = sub.add_parser("rename")
    renaming.add_argument("--id", required=True)
    renaming.add_argument("--filename", required=True)
    renaming.add_argument("--expected-sha", required=True)
    creating = sub.add_parser("create-candidate")
    creating.add_argument("--directory", required=True,
                          choices=["40_Lessons", "60_Evaluations", "70_Feedback"])
    creating.add_argument("--filename", required=True)
    creating.add_argument("--from-file", required=True)
    deprecating = sub.add_parser("deprecate")
    deprecating.add_argument("--id", required=True)
    deprecating.add_argument("--from-file", required=True)
    deprecating.add_argument("--expected-sha", required=True)
    deprecating.add_argument("--reason-ref", required=True)
    args = parser.parse_args(argv)
    try:
        root = vault_root(args.vault)
        notes = load_notes(root) if args.command != "pack" else None
        if args.command == "validate":
            print(f"検証成功: {len(notes)} notes / {root}")
        elif args.command == "search":
            for score, note in search_notes(notes, args.project, args.query,
                                            args.status, args.allow_private)[:20]:
                print(json.dumps({"id": note.id, "score": score, "kind": note.properties["kind"],
                                  "title": note.properties.get("title"), "status": note.properties["status"],
                                  "version": note.properties["version"],
                                  "sha256": note.sha256, "path": note.relative}, ensure_ascii=False))
        elif args.command == "read":
            note = notes.get(args.id.casefold())
            if note is None:
                raise VaultError(f"IDがない: {args.id}")
            print(note.path.read_text(encoding="utf-8-sig"), end="")
        elif args.command == "pack":
            content, stats = compile_current_pack(root, args.project, args.role, args.query,
                args.require, args.max_chars, args.allow_private, args.task_class,
                args.knowledge_proof_dir, args.cache_dir)
            if args.cache_stats:
                print(json.dumps({"context_cache": stats}, sort_keys=True), file=sys.stderr)
            if args.stdout:
                sys.stdout.write(content)
            else:
                out = Path(args.out).expanduser().resolve()
                if out.is_relative_to(root):
                    raise VaultError("派生Context PackをVault内に正本として置かない")
                if out.exists() and not out.read_text(encoding="utf-8").startswith(PACK_MARKER):
                    raise VaultError("既存の無関係な出力ファイルを上書きしない")
                _atomic_write(out, content.encode("utf-8"))
                print(f"Context Pack: {out} / {len(content)} chars")
        elif args.command == "update":
            digest = update_note(root, notes, args.id, Path(args.from_file).expanduser().resolve(strict=True),
                                 args.expected_sha)
            print(f"更新成功: {args.id} / sha256 {digest}")
        elif args.command == "activate":
            digest = update_note(root, notes, args.id, Path(args.from_file).expanduser().resolve(strict=True),
                                 args.expected_sha, args.approval_ref)
            print(f"active化成功: {args.id} / sha256 {digest}")
        elif args.command == "rename":
            relative = rename_note(root, notes, args.id, args.filename, args.expected_sha)
            print(f"名前変更成功: {args.id} / {relative}")
        elif args.command == "create-candidate":
            note_id, digest = create_candidate(root, args.directory, args.filename,
                                               Path(args.from_file).expanduser().resolve(strict=True))
            print(f"候補作成成功: {note_id} / sha256 {digest}")
        elif args.command == "deprecate":
            digest = deprecate_note(root, notes, args.id,
                                    Path(args.from_file).expanduser().resolve(strict=True),
                                    args.expected_sha, args.reason_ref)
            print(f"失効成功: {args.id} / sha256 {digest}")
        return 0
    except (VaultError, OSError) as error:
        print(f"Vault処理失敗: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.modules["negi_vault"] = sys.modules[__name__]
    raise SystemExit(main())
