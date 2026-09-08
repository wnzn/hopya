import { useEffect, useId, useRef, useState } from "react";
import {
  api,
  ApiError,
  evaluateFormula,
  label,
  message,
  priorities,
  workspacePath,
  type Detail,
  type Field,
  type Item,
  type ItemInput,
  type Proposal,
} from "../lib/api";
import { ErrorNotice, Modal } from "./Shared";
import RichTextEditor from "./RichTextEditor";
import CommentsPanel, { mentionTargets } from "./CommentsPanel";
import ProjectFields from "./ProjectFields";
import TypedFieldInput from "./TypedFieldInput";
import { projectStatuses, projectDateFormat, statusStyle } from "../lib/project-statuses";
import { formatFieldDate } from "../lib/field-values";
import { fieldOwnerForNode, hierarchyLabels, projectBuiltIns, projectCustomFields } from "../lib/project-fields";

type Attachment = {
  id: string;
  name: string;
  contentType: string;
  size: number;
};

type ChecklistEntry = { id: string; text: string; done: boolean };
type ItemEx = Item & { checklist?: ChecklistEntry[]; parentId?: string | null };
type DraftEx = ItemInput & { checklist: ChecklistEntry[]; parentId: string | null };

function normalizeChecklist(value: unknown): ChecklistEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ChecklistEntry[] = [];
  for (const entry of value) {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (typeof record.id === "string" && typeof record.text === "string" && typeof record.done === "boolean") {
        if (record.id && record.text.trim())
          out.push({ id: record.id.slice(0, 120), text: record.text.slice(0, 500), done: record.done });
      }
    }
  }
  return out;
}

function toDraft(item: ItemEx | undefined): Omit<DraftEx, "nodeId" | "status"> & { nodeId: string; status: string } {
  const { id: _id, workspaceId: _wid, createdAt: _c, updatedAt: _u, checklist, parentId, ...rest } = (item ?? {}) as Partial<ItemEx> & Record<string, unknown>;
  void _id; void _wid; void _c; void _u;
  return {
    title: typeof rest.title === "string" ? rest.title : "",
    description: typeof rest.description === "string" ? rest.description : "",
    nodeId: typeof rest.nodeId === "string" ? rest.nodeId : "",
    status: typeof rest.status === "string" ? rest.status : "todo",
    priority: (rest.priority as DraftEx["priority"]) ?? "none",
    startDate: (rest.startDate as string | null) ?? null,
    dueDate: (rest.dueDate as string | null) ?? null,
    tags: Array.isArray(rest.tags) ? [...(rest.tags as string[])] : [],
    customFields: typeof rest.customFields === "object" && rest.customFields !== null ? { ...(rest.customFields as Record<string, string | number | boolean | null | string[]>) } : {},
    assigneeId: (rest.assigneeId as string | null) ?? null,
    checklist: normalizeChecklist(checklist),
    parentId: typeof parentId === "string" ? parentId : null,
  };
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

export default function TaskEditor({
  detail: incomingDetail,
  item,
  proposal,
  defaultNode,
  initialParentId,
  onClose,
  onSaved,
  onItemUpdated,
  onMetadataChange,
  onOpenItem,
  mentionItems = [],
  currentUserId,
}: {
  detail: Detail;
  item?: Item;
  proposal?: Proposal;
  defaultNode?: string;
  initialParentId?: string | null;
  onClose: () => void;
  onSaved: () => void;
  onItemUpdated?: (item: Item) => void;
  onMetadataChange?: (detail: Detail) => void;
  onOpenItem?: (item: Item) => void;
  mentionItems?: Item[];
  currentUserId?: string;
}) {
  const [detail, setDetail] = useState(incomingDetail);
  useEffect(() => setDetail(incomingDetail), [incomingDetail]);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const lists = detail.nodes.filter((n) => n.kind === "list");
  const listLabels = hierarchyLabels(detail.nodes, lists);
  const fixedDestination = !proposal && !!defaultNode && lists.some(node => node.id === defaultNode);
  const initialActive = (item ?? null) as ItemEx | null;
  const [active, setActive] = useState<ItemEx | null>(initialActive);
  const [stack, setStack] = useState<ItemEx[]>([]);
  const [current, setCurrent] = useState<ItemEx | null>(initialActive);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftEx>(() => {
    if (item) {
      const base = toDraft(item as ItemEx);
      return base as DraftEx;
    }
    const nodeId = lists.some(node => node.id === proposal?.nodeId)
      ? proposal!.nodeId! : fixedDestination ? defaultNode! : lists[0]?.id || "";
    return {
      title: proposal?.title || "",
      description: proposal?.description || "",
      nodeId,
      status: projectStatuses(detail, nodeId)[0]?.id || "todo",
      priority: proposal?.priority || "none",
      startDate: null,
      dueDate: proposal?.dueDate || null,
      tags: [],
      customFields: {},
      assigneeId: null,
      checklist: [],
      parentId: initialParentId ?? null,
    };
  });
  const [newTag, setNewTag] = useState("");
  const [newChecklist, setNewChecklist] = useState("");
  const [creatingChild, setCreatingChild] = useState(false);
  const [childDraft, setChildDraft] = useState<DraftEx | null>(null);
  const [childError, setChildError] = useState("");
  const [childBusy, setChildBusy] = useState(false);
  const statusChoices = projectStatuses(detail, creatingChild && childDraft ? childDraft.nodeId : draft.nodeId);
  const dateFormat = projectDateFormat(detail, creatingChild && childDraft ? childDraft.nodeId : draft.nodeId);
  const fieldOwner = fieldOwnerForNode(detail.nodes, active?.nodeId || draft.nodeId);
  const fieldsHintId = useId();
  const fields = fieldOwner || detail.projectFields === undefined ? projectCustomFields(detail, fieldOwner?.id) : [];
  const builtIns = fieldOwner || detail.projectFields === undefined ? projectBuiltIns(detail, fieldOwner?.id) : [];
  const hiddenValues = Object.entries(draft.customFields).filter(([id, value]) =>
    value !== null && !fields.some(field => field.id === id));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [attachmentLoading, setAttachmentLoading] = useState(!!item);
  const [attachmentReady, setAttachmentReady] = useState(false);
  const [attachmentRetry, setAttachmentRetry] = useState(0);
  const [subtasks, setSubtasks] = useState<ItemEx[]>([]);
  const [subtasksLoading, setSubtasksLoading] = useState(false);
  const [subtasksError, setSubtasksError] = useState("");
  const [subtasksLimited, setSubtasksLimited] = useState(false);
  const [subtasksRetry, setSubtasksRetry] = useState(0);
  const context = useRef<AbortController | null>(null);
  const optionsMenu = useRef<HTMLDivElement>(null);
  const base = `${workspacePath(detail.workspace.id)}/items`;
  const writable = detail.permissions.includes("items:write");
  const deletable = detail.permissions.includes("items:delete");
  const structureWritable = detail.permissions.includes("structure:write");
  const isNew = !active && !creatingChild;
  const shownItem = active;
  const richMentionTargets = mentionTargets(detail, active && !mentionItems.some(candidate => candidate.id === active.id) ? [...mentionItems, active] : mentionItems);
  useEffect(() => {
    if (!menuOpen) return;
    function dismiss(event: PointerEvent) {
      if (!optionsMenu.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function dismissWithKeyboard(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      optionsMenu.current?.querySelector<HTMLButtonElement>("[aria-label='Task options']")?.focus();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [menuOpen]);
  // Formula fields display the evaluated result of their expression using the
  // current draft's other field values; the stored value stays the raw input.
  function formulaDisplay(
    field: Field,
    currentDraft: ItemInput,
  ): string {
    const values: Record<string, string | number | boolean | null> = {};
    for (const other of detail.fields) {
      if (other.id === field.id) continue;
      const value = currentDraft.customFields[other.id];
      values[other.name] = Array.isArray(value) ? null : value ?? null;
    }
    const expression = field.settings?.formula ?? currentDraft.customFields[field.id];
    return typeof expression === "string" && expression !== ""
      ? evaluateFormula(expression, values)
      : expression === "" || expression == null
        ? ""
        : String(expression);
  }
  function change<K extends keyof DraftEx>(key: K, value: DraftEx[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  function changeList(nodeId: string) {
    setDraft(currentDraft => {
      const choices = projectStatuses(detail, nodeId);
      const status = active && choices.some(choice => choice.id === currentDraft.status)
        ? currentDraft.status
        : choices[0]?.id || "todo";
      return { ...currentDraft, nodeId, status };
    });
  }
  function addTag() {
    const tag = newTag.trim();
    if (!writable || !tag || draft.tags.length >= 30) return;
    if (!draft.tags.includes(tag)) change("tags", [...draft.tags, tag]);
    setNewTag("");
  }
  function openEditor(key: string) {
    if (!writable) return;
    setEditing(key);
  }
  function cancelEditing() {
    if (!current) {
      setEditing(null);
      return;
    }
    const fresh = toDraft(current) as DraftEx;
    setDraft(d => {
      if (!editing) return d;
      if (editing.startsWith("custom:")) {
        const id = editing.slice("custom:".length);
        const next = { ...d.customFields };
        if (current.customFields && id in current.customFields) next[id] = current.customFields[id];
        else delete next[id];
        return { ...d, customFields: next };
      }
      if (editing === "tags") return { ...d, tags: [...fresh.tags] };
      if (editing === "checklist-new") return d;
      const key = editing as keyof DraftEx;
      return { ...d, [key]: fresh[key] } as DraftEx;
    });
    setNewTag("");
    setEditing(null);
  }
  useEffect(() => {
    const controller = new AbortController();
    context.current = controller;
    return () => controller.abort();
  }, [base, active?.id]);
  useEffect(() => {
    const controller = new AbortController();
    setAttachments([]);
    setAttachmentError("");
    setAttachmentReady(false);
    setAttachmentLoading(!!active);
    if (active)
      api<Attachment[]>(
        `${base}/${active.id}/attachments`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setAttachments(result);
          setAttachmentReady(true);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setAttachmentError(message(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setAttachmentLoading(false);
        });
    return () => controller.abort();
  }, [base, active?.id, attachmentRetry]);
  useEffect(() => {
    if (!active || proposal) {
      setSubtasks([]);
      setSubtasksLoading(false);
      setSubtasksError("");
      setSubtasksLimited(false);
      return;
    }
    if (!detail.permissions.includes("items:read")) {
      setSubtasks([]);
      setSubtasksLimited(false);
      return;
    }
    const controller = new AbortController();
    setSubtasksLoading(true);
    setSubtasksError("");
    setSubtasksLimited(false);
    (async () => {
      try {
        const found: ItemEx[] = [];
        let cursor: string | null = null;
        let scanned = 0;
        do {
          const query = new URLSearchParams({ limit: "200" });
          if (cursor) query.set("cursor", cursor);
          const page = await api<{ items: ItemEx[]; nextCursor: string | null }>(
            `${base}/page?${query}`, "GET", undefined, controller.signal,
          );
          controller.signal.throwIfAborted();
          if (!page || !Array.isArray(page.items)) throw new Error("Invalid task page response. Please retry loading.");
          for (const entry of page.items) {
            scanned++;
            const parentId = (entry as ItemEx).parentId ?? null;
            if (parentId === active.id) found.push(entry);
            if (found.length >= 200 || scanned >= 5000) break;
          }
          cursor = page.nextCursor ?? null;
          if (found.length >= 200 || scanned >= 5000) cursor = null;
        } while (cursor !== null);
        if (!controller.signal.aborted) {
          setSubtasks(found);
          setSubtasksLimited(found.length >= 200 || scanned >= 5000);
          setSubtasksLoading(false);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setSubtasksError(message(e));
          setSubtasksLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [base, active?.id, subtasksRetry, detail.permissions, proposal]);
  async function reloadCurrent() {
    if (!active || busy || attachmentBusy) return;
    if (
      !window.confirm(
        "Discard your draft and reload the current task? Your draft is kept if loading fails.",
      )
    ) return;
    const signal = context.current!.signal;
    setBusy(true);
    setError("");
    try {
      const fresh = await api<ItemEx>(
        `${base}/${active.id}`, "GET", undefined, signal,
      );
      signal.throwIfAborted();
      if (fresh.id !== active.id || fresh.workspaceId !== detail.workspace.id)
        throw new Error(
          "The server returned a different task. Your draft has been kept.",
        );
      const nextDraft = toDraft(fresh) as DraftEx;
      // Preserve the node/status reconciliation previously applied to drafts:
      // keep the reloaded values verbatim; the editor derives choices per list.
      setCurrent(fresh);
      setActive(fresh);
      setDraft(nextDraft);
      setNewTag("");
      setNewChecklist("");
      setEditing(null);
      setConflict(false);
      setConfirmDelete(false);
    } catch (e) {
      if (!signal.aborted) setError(message(e));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  async function save() {
    if (busy || attachmentBusy || !writable || conflict || !current) return;
    setError("");
    if (newTag) {
      setError("Add the pending tag or clear its input before saving.");
      return;
    }
    if (draft.startDate && draft.dueDate && draft.startDate > draft.dueDate) {
      setError("The due date must be on or after the start date.");
      return;
    }
    setBusy(true);
    try {
      const input: Record<string, unknown> = {
        title: draft.title,
        description: draft.description,
        nodeId: draft.nodeId,
        status: draft.status,
        priority: draft.priority,
        startDate: draft.startDate,
        dueDate: draft.dueDate,
        tags: draft.tags,
        customFields: draft.customFields,
        assigneeId: draft.assigneeId,
        checklist: draft.checklist,
        parentId: draft.parentId,
      };
      const baseInput: Record<string, unknown> = {
        title: current.title,
        description: current.description,
        nodeId: current.nodeId,
        status: current.status,
        priority: current.priority,
        startDate: current.startDate,
        dueDate: current.dueDate,
        tags: current.tags,
        customFields: current.customFields,
        assigneeId: current.assigneeId,
        checklist: normalizeChecklist(current.checklist),
        parentId: current.parentId ?? null,
      };
      const changed = Object.fromEntries(
        Object.entries(input).filter(
          ([key, value]) => JSON.stringify(value) !== JSON.stringify(baseInput[key]),
        ),
      );
      if (Object.keys(changed).length === 0) {
        setEditing(null);
        setBusy(false);
        return;
      }
      const updated = await api<ItemEx>(
        `${base}/${active!.id}`,
        "PATCH",
        { ...changed, expectedUpdatedAt: current!.updatedAt },
      );
      setCurrent(updated);
      setActive(updated);
      setDraft(toDraft(updated) as DraftEx);
      setEditing(null);
      setConflict(false);
      setBusy(false);
      onItemUpdated?.(updated);
    } catch (e) {
      setError(message(e));
      if (active && e instanceof ApiError && e.status === 409) setConflict(true);
      setBusy(false);
    }
  }
  async function saveNew() {
    if (busy || attachmentBusy || !writable || conflict) return;
    setError("");
    if (newTag) {
      setError("Add the pending tag or clear its input before saving.");
      return;
    }
    if (draft.startDate && draft.dueDate && draft.startDate > draft.dueDate) {
      setError("The due date must be on or after the start date.");
      return;
    }
    setBusy(true);
    try {
      const input = { ...draft };
      await api(base, "POST", input);
      onSaved();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  async function saveChecklist(next: ChecklistEntry[]): Promise<boolean> {
    if (!active || !current || busy || attachmentBusy || !writable || conflict) return false;
    setError("");
    setBusy(true);
    try {
      const updated = await api<ItemEx>(
        `${base}/${active.id}`, "PATCH",
        { checklist: next, expectedUpdatedAt: current.updatedAt },
      );
      const normalized = normalizeChecklist(updated.checklist);
      setCurrent(updated);
      setActive(updated);
      setDraft(d => ({ ...d, checklist: normalized }));
      onItemUpdated?.(updated);
      return true;
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function addChecklistItem() {
    const text = newChecklist.trim();
    if (!text || !writable) return;
    const entry: ChecklistEntry = { id: newId(), text: text.slice(0, 500), done: false };
    setUploadOpen(false);
    void saveChecklist([...draft.checklist, entry]).then(saved => {
      if (saved) setNewChecklist(currentValue => currentValue.trim() === text ? "" : currentValue);
    });
  }
  function toggleChecklist(id: string, done: boolean) {
    void saveChecklist(draft.checklist.map(entry => entry.id === id ? { ...entry, done } : entry));
  }
  function deleteChecklist(id: string) {
    void saveChecklist(draft.checklist.filter(entry => entry.id !== id));
  }
  function openSubtask(sub: ItemEx) {
    if (onOpenItem && sub.parentId !== undefined) {
      // Prefer host navigation when provided; fall back to in-dialog switching.
      try {
        onOpenItem(sub as Item);
        return;
      } catch {
        // fall through to in-dialog navigation
      }
    }
    if (!active) return;
    setStack(s => [...s, active]);
    setActive(sub);
    setCurrent(sub);
    setDraft(toDraft(sub) as DraftEx);
    setEditing(null);
    setConflict(false);
    setError("");
    setConfirmDelete(false);
    setNewTag("");
    setNewChecklist("");
    setMenuOpen(false);
    setCreatingChild(false);
    setChildDraft(null);
  }
  function goBack() {
    setStack(s => {
      if (!s.length) return s;
      const parent = s[s.length - 1];
      setActive(parent);
      setCurrent(parent);
      setDraft(toDraft(parent) as DraftEx);
      setEditing(null);
      setConflict(false);
      setError("");
      setConfirmDelete(false);
      setNewTag("");
      setNewChecklist("");
      setUploadOpen(false);
      setMenuOpen(false);
      setCreatingChild(false);
      setChildDraft(null);
      return s.slice(0, -1);
    });
  }
  function startSubtask() {
    if (!active || !writable) return;
    const nodeId = active.nodeId;
    const choices = projectStatuses(detail, nodeId);
    setChildDraft({
      title: "",
      description: "",
      nodeId,
      status: choices[0]?.id || "todo",
      priority: "none",
      startDate: null,
      dueDate: null,
      tags: [],
      customFields: {},
      assigneeId: null,
      checklist: [],
      parentId: active.id,
    });
    setChildError("");
    setCreatingChild(true);
    setEditing(null);
    setMenuOpen(false);
  }
  async function saveChild() {
    if (!childDraft || childBusy || busy || attachmentBusy || !writable) return;
    setChildError("");
    if (!childDraft.title.trim()) {
      setChildError("Add a title before creating the subtask.");
      return;
    }
    if (childDraft.startDate && childDraft.dueDate && childDraft.startDate > childDraft.dueDate) {
      setChildError("The due date must be on or after the start date.");
      return;
    }
    setChildBusy(true);
    try {
      await api(base, "POST", childDraft);
      onSaved();
    } catch (e) {
      setChildError(message(e));
      setChildBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`${base}/${active!.id}`, "DELETE");
      onSaved();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  async function upload(file?: File) {
    if (
      !file || !active || !writable || busy || attachmentBusy ||
      !attachmentReady || attachmentLoading
    ) return;
    const signal = context.current!.signal;
    if (file.size > 10 * 1024 * 1024) {
      setAttachmentError("Choose a file no larger than 10 MiB.");
      return;
    }
    setAttachmentBusy(true);
    setAttachmentError("");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read the file."));
        reader.readAsDataURL(file);
      });
      signal.throwIfAborted();
      await api(
        `${base}/${active.id}/attachments`,
        "POST",
        {
          name: file.name,
          contentType: file.type || "application/octet-stream",
          data,
        },
        signal,
      );
      const result = await api<Attachment[]>(
        `${base}/${active.id}/attachments`, "GET", undefined, signal,
      );
      signal.throwIfAborted();
      setAttachments(result);
    } catch (e) {
      if (!signal.aborted) {
        setAttachmentError(message(e));
        setAttachmentReady(false);
      }
    } finally {
      if (!signal.aborted) setAttachmentBusy(false);
    }
  }
  async function removeAttachment(attachment: Attachment) {
    if (
      !deletable || busy || attachmentBusy || !attachmentReady || attachmentLoading
    ) return;
    if (!window.confirm(`Delete attachment "${attachment.name}"?`)) return;
    const signal = context.current!.signal;
    setAttachmentBusy(true);
    setAttachmentError("");
    try {
      await api(
        `${base}/${active!.id}/attachments/${attachment.id}`,
        "DELETE", undefined, signal,
      );
      signal.throwIfAborted();
      setAttachments((a) => a.filter((v) => v.id !== attachment.id));
    } catch (e) {
      if (!signal.aborted) {
        setAttachmentError(message(e));
        setAttachmentReady(false);
      }
    } finally {
      if (!signal.aborted) setAttachmentBusy(false);
    }
  }
  const memberName = (id: string | null) => {
    if (!id) return "Unassigned";
    const member = detail.members.find(m => m.userId === id);
    return member ? `${member.name} (${member.email})` : "Unassigned";
  };
  const statusName = (id: string) =>
    statusChoices.find(s => s.id === id)?.name ?? label(id);
  function customDisplay(field: Field): string {
    const value = draft.customFields[field.id];
    if (value == null) return "Not set";
    if (field.type === "checkbox") return value === true ? "Yes" : value === false ? "No" : "Not set";
    if (field.type === "formula") return formulaDisplay(field, draft) || "Not set";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "Not set";
    if (field.type === "date" || field.type === "datetime")
      return typeof value === "string" ? formatFieldDate(value, field.settings?.dateFormat ?? dateFormat, field.type === "datetime") : "Not set";
    return String(value) || "Not set";
  }
  function renderCustomEditor(field: Field) {
    if (["datetime", "checklist", "rating"].includes(field.type))
      return <TypedFieldInput field={field} value={draft.customFields[field.id] ?? null} disabled={!writable || busy}
        onChange={value => change("customFields", { ...draft.customFields, [field.id]: value })} />;
    return <label>
      {field.name}
      {field.type === "checkbox" ? (
        <input
          type="checkbox"
          autoFocus
          disabled={!writable || busy}
          aria-describedby={`custom-${field.id}-state`}
          checked={draft.customFields[field.id] === true}
          onChange={(e) =>
            change("customFields", {
              ...draft.customFields,
              [field.id]: e.target.checked,
            })
          }
        />
      ) : field.type === "select" ? (
        <select
          autoFocus
          disabled={!writable || busy}
          value={String(draft.customFields[field.id] ?? "")}
          onChange={(e) =>
            change("customFields", {
              ...draft.customFields,
              [field.id]: e.target.value || null,
            })
          }
        >
          <option value="">Not set</option>
          {field.options?.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : field.type === "formula" && field.settings?.formula !== undefined ? (
        <output aria-label={`${field.name} calculated value`}>{formulaDisplay(field, draft) || "Not set"}</output>
      ) : field.type === "formula" ? (
        <>
          {writable ? (
            <input
              autoFocus
              type="text"
              maxLength={200}
              value={
                draft.customFields[field.id] == null
                  ? ""
                  : String(draft.customFields[field.id])
              }
              onChange={(e) =>
                change("customFields", {
                  ...draft.customFields,
                  [field.id]:
                    e.target.value === ""
                      ? null
                      : e.target.value,
                })
              }
            />
          ) : (
            <input
              type="text"
              readOnly
              value={formulaDisplay(field, draft)}
            />
          )}
          {writable &&
            typeof draft.customFields[field.id] ===
              "string" &&
            (draft.customFields[field.id] as string).length >
              0 && (
              <small
                id={`custom-${field.id}-state`}
                aria-live="polite"
              >
                Preview: {formulaDisplay(field, draft)}
              </small>
            )}
        </>
      ) : (
        <input
          autoFocus
          readOnly={!writable}
          type={
            field.type === "number"
              ? "number"
              : field.type === "date"
                ? "date"
                : "text"
          }
          step={field.type === "number" ? "any" : undefined}
          maxLength={2000}
          value={String(draft.customFields[field.id] ?? "")}
          onChange={(e) =>
            change("customFields", {
              ...draft.customFields,
              [field.id]:
                e.target.value === ""
                  ? null
                  : field.type === "number"
                    ? Number(e.target.value)
                    : e.target.value,
            })
          }
        />
      )}
    </label>;
  }
  function renderAddFields() {
    if (!structureWritable) return null;
    return <div className="task-fields-action">
      <button type="button" aria-disabled={!fieldOwner}
        aria-describedby={!fieldOwner ? fieldsHintId : undefined}
        onClick={() => { if (fieldOwner) setFieldsOpen(true); }}>
        Add fields
      </button>
      {!fieldOwner && <span id={fieldsHintId} role="tooltip" className="task-fields-hint">
        Field configuration is unavailable for this list.
      </span>}
    </div>;
  }
  function renderInlineActions() {
    return (
      <div className="inline-form task-detail-inline-actions">
        <button type="button" className="task-detail-save" aria-label="Save changes" disabled={busy || attachmentBusy || conflict} onClick={() => void save()}>
          <span aria-hidden="true">✓</span> Save
        </button>
        <button type="button" disabled={busy} onClick={cancelEditing}>
          Cancel editing
        </button>
      </div>
    );
  }
  function renderTaskHeading() {
    const title = editing === "title" ? <div className="task-detail-title-editor">
        <label className="sr-only" htmlFor="task-detail-title">Title</label>
        <input id="task-detail-title" autoFocus name="title" readOnly={!writable} value={draft.title}
          onChange={(event) => change("title", event.target.value)} required maxLength={300}
          placeholder="What needs to happen?" />
        {renderInlineActions()}
      </div> : <h2 className="task-detail-heading-title">
      <button type="button" aria-label="Edit title" disabled={busy || !writable} onClick={() => openEditor("title")}>
        {draft.title || "No title yet"}
      </button>
    </h2>;
    return <div className="task-detail-heading">
      {title}
      {shownItem && current && <div className="task-detail-timestamps">
        <span>Created <time dateTime={shownItem.createdAt}>{new Date(shownItem.createdAt).toLocaleString()}</time></span>
        <span aria-hidden="true">·</span>
        <span>Updated <time dateTime={current.updatedAt}>{new Date(current.updatedAt).toLocaleString()}</time></span>
      </div>}
    </div>;
  }
  function renderValueRow(key: string, fieldLabel: string, display: string, editor: React.ReactNode) {
    const isOpen = editing === key;
    if (isOpen) {
      return (
        <div className={`stack task-detail-field task-detail-field-${key}`}>
          {editor}
          {(fieldLabel === "Start date" || fieldLabel === "Due date") && null}
          {renderInlineActions()}
        </div>
      );
    }
    return (
      <div className={`stack task-detail-field task-detail-field-${key}`}>
        <span>{fieldLabel}</span>
        <button type="button" autoFocus={key === "title" && !stack.length} aria-label={`Edit ${fieldLabel.toLowerCase()}`} disabled={busy || !writable} onClick={() => openEditor(key)}>
          <span style={{ overflowWrap: "anywhere" }}>{display || "Not set"}</span>
        </button>
      </div>
    );
  }
  if (proposal || isNew) {
    return (
      <>
      <Modal
        title={
          proposal ? "Review suggested task" : "New task"
        }
        onClose={() => {
          if (!busy && !attachmentBusy) onClose();
        }}
      >
        {proposal && (
          <p className="notice">
            AI suggestions can be wrong. Review every field. Nothing is created
            until you choose Confirm and create.
          </p>
        )}
        {draft.parentId && (
          <p className="muted">Creating a subtask (parent linked).</p>
        )}
        <ErrorNotice error={error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!proposal) void saveNew();
          }}
          className="stack"
        >
          <fieldset disabled={busy} className="stack bare-fieldset">
            <label>
              Title
              <input
                autoFocus
                name="title"
                aria-label="Title"
                readOnly={!writable}
                value={draft.title}
                onChange={(e) => change("title", e.target.value)}
                required
                maxLength={300}
                placeholder="What needs to happen?"
              />
            </label>
            <div className="stack">
              <span>Body</span>
              <RichTextEditor
                aria-label="Body"
                value={draft.description}
                onChange={(v) => change("description", v.slice(0, 50000))}
                readOnly={!writable}
                placeholder="Add context, decisions, or a useful next step..."
                mentionTargets={richMentionTargets}
              />
            </div>
            <div className="form-grid">
              {!fixedDestination && <label>
                List
                <select
                  disabled={!writable}
                  value={draft.nodeId}
                  required
                  onChange={(e) => changeList(e.target.value)}
                >
                  <option value="" disabled>
                    Select a list
                  </option>
                  {lists.map((n) => (
                    <option key={n.id} value={n.id}>
                      {listLabels.get(n.id)}
                    </option>
                  ))}
                </select>
              </label>}
              <label>
                Assignee
                <select
                  disabled={!writable}
                  value={draft.assigneeId || ""}
                  onChange={(e) => change("assigneeId", e.target.value || null)}
                >
                  <option value="">Unassigned</option>
                  {detail.members.map((m) => (
                    <option key={m.userId} value={m.userId} disabled={m.disabled}>
                      {m.name} ({m.email}){m.disabled ? " - disabled" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Status
                <select
                  disabled={!writable}
                  value={draft.status}
                  style={statusStyle(statusChoices.find(status => status.id === draft.status)?.color ?? "#64748b")}
                  onChange={(e) =>
                    change("status", e.target.value as Item["status"])
                  }
                >
                  {!statusChoices.some(status => status.id === draft.status) && <option value={draft.status} disabled>{label(draft.status)} (unavailable in this project)</option>}
                  {statusChoices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {(builtIns.includes("priority") || proposal?.priority !== undefined) && <label>
                Priority
                <select
                  disabled={!writable}
                  value={draft.priority}
                  onChange={(e) =>
                    change("priority", e.target.value as Item["priority"])
                  }
                >
                  {priorities.map((p) => (
                    <option key={p} value={p}>
                      {label(p)}
                    </option>
                  ))}
                </select>
              </label>}
              {builtIns.includes("startDate") && <label>
                Start date
                <input
                  aria-label="Start date"
                  type="date"
                  readOnly={!writable}
                  value={draft.startDate || ""}
                  onChange={(e) => change("startDate", e.target.value || null)}
                />
                <small>{draft.startDate && formatFieldDate(draft.startDate, dateFormat)}</small>
              </label>}
              <label>
                Due date
                <input
                  aria-label="Due date"
                  type="date"
                  readOnly={!writable}
                  min={draft.startDate || undefined}
                  value={draft.dueDate || ""}
                  onChange={(e) => change("dueDate", e.target.value || null)}
                />
                <small>{draft.dueDate && formatFieldDate(draft.dueDate, dateFormat)}</small>
              </label>
            </div>
            {(builtIns.includes("tags") || draft.tags.length > 0 || newTag !== "") && <section aria-labelledby="tags-heading">
              {!builtIns.includes("tags") && <p className="muted">Tags are hidden for this project. Add or clear the pending tag before saving.</p>}
              <h3 id="tags-heading">Tags</h3>
              <ul className="tag-editor" aria-label="Tags">
                {draft.tags.map((tag, index) => (
                  <li key={index}>
                    <span>{tag}</span>
                    <button
                      type="button"
                      disabled={!writable}
                      aria-label={`Remove tag ${tag}`}
                      onClick={() =>
                        change(
                          "tags",
                          draft.tags.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="inline-form">
                <label>
                  New tag
                  <input
                    readOnly={!writable}
                    aria-label="New tag"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    maxLength={60}
                    placeholder="e.g. triage,urgent"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={addTag}
                  disabled={
                    !writable || !newTag.trim() || draft.tags.length >= 30
                  }
                >
                  Add tag
                </button>
              </div>
              <p className="muted">Add one tag at a time. Commas are part of a tag, not separators. Up to 30 tags.</p>
            </section>}
            <details>
              <summary>Checklist</summary>
              <ul aria-label="Checklist items">
                {draft.checklist.map(entry => (
                  <li key={entry.id}>
                    <label>
                      <input type="checkbox" checked={entry.done}
                        onChange={e => change("checklist", draft.checklist.map(v => v.id === entry.id ? { ...v, done: e.target.checked } : v))} />
                      {entry.text}
                    </label>
                    <button type="button" aria-label={`Delete checklist item ${entry.text}`}
                      onClick={() => change("checklist", draft.checklist.filter(v => v.id !== entry.id))}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
              <div className="inline-form">
                <label>
                  New checklist item
                  <input value={newChecklist} onChange={e => setNewChecklist(e.target.value)}
                    aria-label="New checklist item"
                    maxLength={500} placeholder="e.g. Confirm scope"
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const text = newChecklist.trim();
                        if (text) {
                          change("checklist", [...draft.checklist, { id: newId(), text, done: false }]);
                          setNewChecklist("");
                        }
                      }
                    }} />
                </label>
                <button type="button" disabled={!newChecklist.trim()}
                  onClick={() => {
                    const text = newChecklist.trim();
                    if (!text) return;
                    change("checklist", [...draft.checklist, { id: newId(), text, done: false }]);
                    setNewChecklist("");
                  }}>
                  Add checklist item
                </button>
              </div>
            </details>
            {renderAddFields()}
            {fields.length > 0 && (
              <section>
                <h3>Custom fields</h3>
                <div className="form-grid">
                  {fields.map((field) => (
                    <div key={field.id} className="stack">
                      {["datetime", "checklist", "rating"].includes(field.type) ? <TypedFieldInput field={field} value={draft.customFields[field.id] ?? null} disabled={!writable}
                        onChange={value => change("customFields", { ...draft.customFields, [field.id]: value })} /> : <label>
                        {field.name}
                        {field.type === "checkbox" ? (
                          <input
                            type="checkbox"
                            disabled={!writable}
                            aria-describedby={`custom-${field.id}-state`}
                            checked={draft.customFields[field.id] === true}
                            onChange={(e) =>
                              change("customFields", {
                                ...draft.customFields,
                                [field.id]: e.target.checked,
                              })
                            }
                          />
                        ) : field.type === "select" ? (
                          <select
                            disabled={!writable}
                            value={String(draft.customFields[field.id] ?? "")}
                            onChange={(e) =>
                              change("customFields", {
                                ...draft.customFields,
                                [field.id]: e.target.value || null,
                              })
                            }
                          >
                            <option value="">Not set</option>
                            {field.options?.map((option) => (
                              <option key={option}>{option}</option>
                            ))}
                          </select>
                        ) : field.type === "formula" && field.settings?.formula !== undefined ? (
                          <output aria-label={`${field.name} calculated value`}>{formulaDisplay(field, draft) || "Not set"}</output>
                        ) : field.type === "formula" ? (
                          <>
                            {writable ? (
                              <input
                                type="text"
                                maxLength={200}
                                value={
                                  draft.customFields[field.id] == null
                                    ? ""
                                    : String(draft.customFields[field.id])
                                }
                                onChange={(e) =>
                                  change("customFields", {
                                    ...draft.customFields,
                                    [field.id]:
                                      e.target.value === ""
                                        ? null
                                        : e.target.value,
                                  })
                                }
                              />
                            ) : (
                              <input
                                type="text"
                                readOnly
                                value={formulaDisplay(field, draft)}
                              />
                            )}
                            {writable &&
                              typeof draft.customFields[field.id] ===
                                "string" &&
                              (draft.customFields[field.id] as string).length >
                                0 && (
                                <small
                                  id={`custom-${field.id}-state`}
                                  aria-live="polite"
                                >
                                  Preview: {formulaDisplay(field, draft)}
                                </small>
                              )}
                          </>
                        ) : (
                          <input
                            readOnly={!writable}
                            type={
                              field.type === "number"
                                ? "number"
                                : field.type === "date"
                                  ? "date"
                                  : "text"
                            }
                            step={field.type === "number" ? "any" : undefined}
                            maxLength={2000}
                            value={String(draft.customFields[field.id] ?? "")}
                            onChange={(e) =>
                              change("customFields", {
                                ...draft.customFields,
                                [field.id]:
                                  e.target.value === ""
                                    ? null
                                    : field.type === "number"
                                      ? Number(e.target.value)
                                      : e.target.value,
                              })
                            }
                          />
                        )}
                      </label>}
                      {(field.type === "date" || field.type === "datetime") && typeof draft.customFields[field.id] === "string" && <small>{formatFieldDate(draft.customFields[field.id] as string, field.settings?.dateFormat ?? dateFormat, field.type === "datetime")}</small>}
                      {field.type === "checkbox" && (
                        <>
                          <small id={`custom-${field.id}-state`}>
                            {draft.customFields[field.id] == null
                              ? "Not set"
                              : draft.customFields[field.id] ? "Yes" : "No"}
                          </small>
                          {writable && (
                            <button
                              type="button"
                              aria-label={`Clear ${field.name}`}
                              disabled={draft.customFields[field.id] == null}
                              onClick={() => change("customFields", {
                                ...draft.customFields, [field.id]: null,
                              })}
                            >
                              Clear
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
            {hiddenValues.length > 0 && <details>
              <summary>Other saved fields</summary>
              <p className="view-help">These values are retained but not assigned to this project. Add the existing fields to restore editing.</p>
              <dl>{hiddenValues.map(([id, value]) => <div key={id}>
                <dt>{detail.fields.find(field => field.id === id)?.name || id}</dt>
                <dd>{String(value)}</dd>
              </div>)}</dl>
            </details>}
          </fieldset>
          <div className="modal-actions">
            <span className="spacer" />
            <button
              type="button"
              disabled={busy || attachmentBusy}
              onClick={onClose}
            >
              Cancel
            </button>
            {writable && (
              <button
                type={proposal ? "button" : "submit"}
                className="primary"
                disabled={busy || attachmentBusy || conflict || !draft.nodeId}
                onClick={(event) => {
                  if (proposal && event.currentTarget.form?.reportValidity())
                    void saveNew();
                }}
              >
                {busy
                  ? "Saving..."
                  : proposal
                    ? "Confirm and create"
                    : "Create task"}
              </button>
            )}
          </div>
        </form>
      </Modal>
        {fieldsOpen && fieldOwner && structureWritable && <ProjectFields
          key={`${detail.workspace.id}:${draft.nodeId}`}
          detail={detail} targetId={draft.nodeId} onClose={() => setFieldsOpen(false)}
          onUpdated={fresh => { setDetail(fresh); onMetadataChange?.(fresh); }}
        />}
      </>
    );
  }
  const doneCount = draft.checklist.filter(entry => entry.done).length;
  return (
    <>
    <Modal
      title="Task details"
      heading={renderTaskHeading()}
      headerActions={<div ref={optionsMenu} className="task-options">
        <button type="button" className="icon-button" aria-label="Task options" aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={() => setMenuOpen(value => !value)}>⋯</button>
        {menuOpen && <div className="task-options-menu" role="menu" aria-label="Task options">
          {structureWritable && fieldOwner && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setFieldsOpen(true); }}>Add field to this list</button>}
          {shownItem && deletable && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}>Delete task</button>}
        </div>}
      </div>}
      className="task-detail-modal"
      focusFirstField={!shownItem}
      onClose={() => {
        if (!busy && !attachmentBusy && !childBusy) onClose();
      }}
    >
      {stack.length > 0 && (
        <button type="button" disabled={busy || attachmentBusy || childBusy} onClick={goBack}>
          Back to parent task
        </button>
      )}
      <div className={shownItem && !creatingChild ? "task-detail-layout" : ""}>
      <div className="task-detail-main">
      {creatingChild && childDraft ? (
        <form className="stack" onSubmit={e => { e.preventDefault(); void saveChild(); }}>
          <ErrorNotice error={childError} />
          <p className="muted">Creating a subtask of {active?.title}.</p>
          <label>
            Title
            <input autoFocus value={childDraft.title} required maxLength={300}
              placeholder="What needs to happen?"
              onChange={e => setChildDraft({ ...childDraft, title: e.target.value })} />
          </label>
          <div className="stack">
            <span>Body</span>
            <RichTextEditor aria-label="Body" value={childDraft.description}
              onChange={v => setChildDraft({ ...childDraft, description: v.slice(0, 50000) })}
              placeholder="Add context, decisions, or a useful next step..." mentionTargets={richMentionTargets} />
          </div>
          <div className="inline-form">
            <button type="button" disabled={childBusy} onClick={() => { setCreatingChild(false); setChildDraft(null); setChildError(""); }}>
              Cancel subtask
            </button>
            <button type="submit" className="primary" disabled={childBusy || !childDraft.title.trim()}>
              {childBusy ? "Saving..." : "Create subtask"}
            </button>
          </div>
        </form>
      ) : (
      <>
      <ErrorNotice error={error} />
      {conflict && (
        <div className="notice">
          <p>
            Your draft has not been saved. Reload the current task to review the
            latest version before editing again.
          </p>
          <button
            type="button"
            disabled={busy || attachmentBusy}
            onClick={() => void reloadCurrent()}
          >
            {busy ? "Reloading..." : "Reload current task"}
          </button>
        </div>
      )}
      <div className="stack">
        <div className="form-grid task-detail-metadata">
          {renderValueRow("assigneeId", "Assignee", memberName(draft.assigneeId), (
            <label>
              Assignee
              <select
                autoFocus
                disabled={!writable || busy}
                value={draft.assigneeId || ""}
                onChange={(e) => change("assigneeId", e.target.value || null)}
              >
                <option value="">Unassigned</option>
                {detail.members.map((m) => (
                  <option key={m.userId} value={m.userId} disabled={m.disabled}>
                    {m.name} ({m.email}){m.disabled ? " - disabled" : ""}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {renderValueRow("status", "Status", statusName(draft.status), (
            <label>
              Status
              <select
                autoFocus
                disabled={!writable || busy}
                value={draft.status}
                style={statusStyle(statusChoices.find(status => status.id === draft.status)?.color ?? "#64748b")}
                onChange={(e) => change("status", e.target.value as Item["status"])}
              >
                {!statusChoices.some(status => status.id === draft.status) && <option value={draft.status} disabled>{label(draft.status)} (unavailable in this project)</option>}
                {statusChoices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {(builtIns.includes("priority") || draft.priority !== "none") && renderValueRow("priority", "Priority", label(draft.priority), (
            <label>
              Priority
              <select
                autoFocus
                disabled={!writable || busy}
                value={draft.priority}
                onChange={(e) => change("priority", e.target.value as Item["priority"])}
              >
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {label(p)}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {(builtIns.includes("startDate") || draft.startDate) && renderValueRow("startDate", "Start date", draft.startDate ? formatFieldDate(draft.startDate, dateFormat) : "Not set", (
            <label>
              Start date
              <input
                autoFocus
                aria-label="Start date"
                type="date"
                readOnly={!writable}
                value={draft.startDate || ""}
                onChange={(e) => change("startDate", e.target.value || null)}
              />
              <small>{draft.startDate && formatFieldDate(draft.startDate, dateFormat)}</small>
            </label>
          ))}
          {renderValueRow("dueDate", "Due date", draft.dueDate ? formatFieldDate(draft.dueDate, dateFormat) : "Not set", (
            <label>
              Due date
              <input
                autoFocus
                aria-label="Due date"
                type="date"
                readOnly={!writable}
                min={draft.startDate || undefined}
                value={draft.dueDate || ""}
                onChange={(e) => change("dueDate", e.target.value || null)}
              />
              <small>{draft.dueDate && formatFieldDate(draft.dueDate, dateFormat)}</small>
            </label>
          ))}
        </div>
        <div className="stack task-detail-description">
          <span>Body</span>
          <RichTextEditor
            aria-label="Body"
            value={draft.description}
            onChange={(v) => {
              if (editing !== "description" || !writable) return;
              change("description", v.slice(0, 50000));
            }}
            onActivate={() => openEditor("description")}
            readOnly={editing !== "description" || !writable}
            placeholder="Add context, decisions, or a useful next step..."
            mentionTargets={richMentionTargets}
          />
          {editing === "description" && renderInlineActions()}
        </div>
        {(builtIns.includes("tags") || draft.tags.length > 0 || newTag !== "" || editing === "tags") && (
          <section aria-labelledby="tags-heading">
            <h3 id="tags-heading">Tags</h3>
            <ul className="tag-editor" aria-label="Tags">
              {draft.tags.map((tag, index) => (
                <li key={index}>
                  <span>{tag}</span>
                  {editing === "tags" && (
                    <button
                      type="button"
                      disabled={!writable || busy}
                      aria-label={`Remove tag ${tag}`}
                      onClick={() => change("tags", draft.tags.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {editing === "tags" ? (
              <>
                {!builtIns.includes("tags") && <p className="muted">Tags are hidden for this project. Add or clear the pending tag before saving.</p>}
                <div className="inline-form">
                  <label>
                    New tag
                    <input
                      autoFocus
                      readOnly={!writable}
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      maxLength={60}
                      placeholder="e.g. triage,urgent"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTag();
                        }
                      }}
                    />
                  </label>
                  <button type="button" onClick={addTag} disabled={!writable || !newTag.trim() || draft.tags.length >= 30}>
                    Add tag
                  </button>
                </div>
                <p className="muted">Add one tag at a time. Commas are part of a tag, not separators. Up to 30 tags.</p>
                {renderInlineActions()}
              </>
            ) : (
              writable && (
                <button type="button" aria-label="Edit tags" disabled={busy} onClick={() => openEditor("tags")}>
                  Edit tags
                </button>
              )
            )}
          </section>
        )}
        {fields.length > 0 && (
          <section>
            <h3>Custom fields</h3>
            <div className="form-grid">
              {fields.map((field) => {
                const key = `custom:${field.id}`;
                if (editing === key) {
                  return (
                    <div key={field.id} className="stack">
                      {renderCustomEditor(field)}
                      {(field.type === "date" || field.type === "datetime") && typeof draft.customFields[field.id] === "string" && <small>{formatFieldDate(draft.customFields[field.id] as string, field.settings?.dateFormat ?? dateFormat, field.type === "datetime")}</small>}
                      {field.type === "checkbox" && (
                        <small id={`custom-${field.id}-state`}>
                          {draft.customFields[field.id] == null ? "Not set" : draft.customFields[field.id] ? "Yes" : "No"}
                        </small>
                      )}
                      {renderInlineActions()}
                    </div>
                  );
                }
                return (
                  <div key={field.id} className="stack">
                    <span>{field.name}</span>
                    {field.type === "formula" && field.settings?.formula !== undefined
                      ? <output aria-label={`${field.name} calculated value`}>{customDisplay(field)}</output>
                      : <button type="button" aria-label={`Edit ${field.name}`} disabled={busy || !writable} onClick={() => openEditor(key)}>{customDisplay(field)}</button>}
                    {field.type === "checkbox" && (
                      <small id={`custom-${field.id}-state`}>
                        {draft.customFields[field.id] == null ? "Not set" : draft.customFields[field.id] ? "Yes" : "No"}
                      </small>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {hiddenValues.length > 0 && <details>
          <summary>Other saved fields</summary>
          <p className="view-help">These values are retained but not assigned to this project. Add the existing fields to restore editing.</p>
          <dl>{hiddenValues.map(([id, value]) => <div key={id}>
            <dt>{detail.fields.find(field => field.id === id)?.name || id}</dt>
            <dd>{String(value)}</dd>
          </div>)}</dl>
        </details>}
        <details key={active?.id}>
          <summary>Checklist</summary>
          <p className="muted" aria-live="polite">{doneCount} of {draft.checklist.length} complete</p>
          <ul aria-label="Checklist items">
            {draft.checklist.map(entry => (
              <li key={entry.id}>
                <label>
                  <input type="checkbox" checked={entry.done} disabled={!writable || busy}
                    onChange={e => toggleChecklist(entry.id, e.target.checked)} />
                  {entry.text}
                </label>
                <button type="button" aria-label={`Delete checklist item ${entry.text}`}
                  disabled={!writable || busy} onClick={() => deleteChecklist(entry.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
          {writable && (
            <div className="inline-form">
              <label>
                New checklist item
                <input value={newChecklist} onChange={e => setNewChecklist(e.target.value)}
                  aria-label="New checklist item"
                  maxLength={500} placeholder="e.g. Confirm scope"
                  disabled={busy || conflict}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addChecklistItem();
                    }
                  }} />
              </label>
              <button type="button" disabled={!writable || busy || conflict || !newChecklist.trim()} onClick={addChecklistItem}>
                Add checklist item
              </button>
            </div>
          )}
        </details>
        <section className="task-detail-subtasks" aria-labelledby="subtasks-heading">
          <div className="task-detail-subtasks-header">
            <div className="task-detail-subtasks-title">
              <h3 id="subtasks-heading">Subtasks</h3>
              {!subtasksLoading && <span aria-label={subtasksLimited ? `At least ${subtasks.length} subtasks` : `${subtasks.length} subtasks`}>{subtasks.length}{subtasksLimited ? "+" : ""}</span>}
            </div>
            {writable && (
              <button type="button" disabled={busy || attachmentBusy || childBusy} onClick={startSubtask}>
                <span aria-hidden="true">+</span> Add subtask
              </button>
            )}
          </div>
          <div className="task-detail-subtasks-body">
            {subtasksError && <ErrorNotice error={subtasksError} />}
            {subtasksLoading && <p className="task-detail-subtasks-state" role="status">Loading subtasks...</p>}
            {!subtasksLoading && !subtasksError && subtasks.length === 0 && (
              <p className="task-detail-subtasks-state muted">No subtasks yet.</p>
            )}
            {subtasks.length > 0 && <ul aria-label="Subtasks">
              {subtasks.map(sub => (
                <li key={sub.id}>
                  <button type="button" disabled={busy || attachmentBusy || childBusy} onClick={() => openSubtask(sub)}>
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 4v9a3 3 0 0 0 3 3h11m-5-5 5 5-5 5" />
                    </svg>
                    <span>{sub.title || "Untitled subtask"}</span>
                    <span className="task-detail-subtask-open" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>}
            {subtasksLimited && <p className="task-detail-subtasks-limit">Showing the first {subtasks.length} subtasks.</p>}
            {subtasksError && (
              <button type="button" onClick={() => setSubtasksRetry(v => v + 1)}>
                Retry subtasks
              </button>
            )}
          </div>
        </section>
      </div>
      </>
      )}
      {confirmDelete && (
        <div className="notice error">
          <p>Delete this task and its attachments? This cannot be undone.</p>
          <button
            type="button"
            disabled={busy || attachmentBusy}
            className="danger"
            onClick={remove}
          >
            Permanently delete
          </button>{" "}
          <button disabled={busy} onClick={() => setConfirmDelete(false)}>
            Keep task
          </button>
        </div>
      )}
      {shownItem && !creatingChild && (
        <section className="attachments">
          <h3>Attachments</h3>
          <ErrorNotice error={attachmentError} />
          {attachmentLoading && <p role="status">Loading attachments...</p>}
          {attachmentError && (
            <button
              type="button"
              disabled={busy || attachmentBusy || attachmentLoading}
              onClick={() => setAttachmentRetry((value) => value + 1)}
            >
              Retry attachments
            </button>
          )}
          {attachmentReady && !attachmentLoading && !attachmentBusy &&
            !attachmentError && attachments.length === 0 && (
              <p className="muted">No attachments yet.</p>
            )}
          <ul>
            {attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={`/api/v1${base}/${shownItem.id}/attachments/${a.id}`}
                  download
                >
                  {a.name}
                </a>
                <small>{(a.size / 1024).toFixed(1)} KiB</small>
                {deletable && (
                  <button
                    aria-label={`Delete attachment ${a.name}`}
                    disabled={
                      attachmentBusy || busy || attachmentLoading || !attachmentReady
                    }
                    onClick={() => void removeAttachment(a)}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
          {writable && !uploadOpen && (
            <button type="button" disabled={attachmentBusy || busy || attachmentLoading || !attachmentReady}
              onClick={() => setUploadOpen(true)}>Add attachment</button>
          )}
          {writable && uploadOpen && (
            <div className="stack attachment-upload">
            <label>
              Attach a file (up to 10 MiB)
              <input
                type="file"
                aria-label="Attach a file"
                disabled={
                  attachmentBusy || busy || attachmentLoading || !attachmentReady
                }
                onChange={(e) => {
                  void upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <button type="button" disabled={attachmentBusy} onClick={() => setUploadOpen(false)}>Cancel attachment</button>
            </div>
          )}
          {attachmentBusy && <p role="status">Updating attachments...</p>}
        </section>
      )}
      </div>
      {shownItem && !creatingChild && <CommentsPanel detail={detail} item={shownItem} items={mentionItems} currentUserId={currentUserId} />}
      </div>
    </Modal>
      {fieldsOpen && fieldOwner && structureWritable && <ProjectFields
        key={`${detail.workspace.id}:${draft.nodeId}`}
        detail={detail} targetId={draft.nodeId} onClose={() => setFieldsOpen(false)}
        onUpdated={fresh => { setDetail(fresh); onMetadataChange?.(fresh); }}
      />}
    </>
  );
}
