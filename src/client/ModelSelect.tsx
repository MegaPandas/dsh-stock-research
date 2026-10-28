import { useEffect, useId, useRef, useState } from "react";

interface ModelOption {
  id: string;
  name: string;
}

export function ModelSelect({
  label,
  models,
  value,
  disabled,
  onChange,
}: {
  label: string;
  models: readonly ModelOption[];
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const expanded = open && !disabled;
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(value);
  const selected = models.find((model) => model.id === value);
  const matching = models.filter((model) =>
    `${model.name} ${model.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const activeIndex = Math.max(
    0,
    matching.findIndex((model) => model.id === activeId),
  );
  const active = matching[activeIndex];

  function expand() {
    setQuery("");
    setActiveId(value);
    setOpen(true);
  }
  function close() {
    setOpen(false);
    setQuery("");
  }
  function choose(model: ModelOption) {
    if (model.id !== value) onChange(model.id);
    close();
  }
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current!.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [expanded]);
  useEffect(() => {
    if (!expanded || !active) return;
    const menu = list.current!;
    const option = menu.children[activeIndex] as HTMLElement;
    const bottom = option.offsetTop + option.offsetHeight;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (bottom > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = bottom - menu.clientHeight;
  }, [expanded, active, activeIndex]);

  return (
    <div className="sr-model-field" ref={container}>
      <label htmlFor={id}>{label}</label>
      <div className="sr-model-control">
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={expanded}
          aria-controls={`${id}-options`}
          aria-activedescendant={
            expanded && active ? `${id}-option-${activeIndex}` : undefined
          }
          autoComplete="off"
          disabled={disabled}
          placeholder={expanded ? "搜索模型名称或 ID" : "选择模型"}
          value={expanded ? query : (selected?.name ?? value)}
          onFocus={expand}
          onClick={() => {
            if (!open) expand();
          }}
          onBlur={close}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId("");
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (!open) expand();
              else if (active) choose(active);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) expand();
              else {
                const nextIndex = Math.min(
                  matching.length - 1,
                  Math.max(
                    0,
                    activeIndex + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
                if (matching[nextIndex]) setActiveId(matching[nextIndex].id);
              }
            } else if (open && (event.key === "Home" || event.key === "End")) {
              event.preventDefault();
              const next = event.key === "Home" ? matching[0] : matching.at(-1);
              if (next) setActiveId(next.id);
            }
          }}
        />
        <button
          type="button"
          className="sr-model-toggle"
          tabIndex={-1}
          aria-label={`${expanded ? "收起" : "展开"}${label}`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) close();
            else {
              input.current!.focus();
              expand();
            }
          }}
        >
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
      {expanded && (
        <ul
          ref={list}
          id={`${id}-options`}
          className="sr-model-options"
          role="listbox"
          aria-label={label}
        >
          {matching.map((model, index) => (
            <li
              key={model.id}
              id={`${id}-option-${index}`}
              role="option"
              aria-label={`${model.name} ${model.id}`}
              aria-selected={model.id === value}
              className={index === activeIndex ? "sr-model-active" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActiveId(model.id)}
              onClick={() => choose(model)}
            >
              <span>{model.name}</span>
              <small>{model.id}</small>
            </li>
          ))}
          {matching.length === 0 && (
            <li role="presentation" className="sr-model-empty">
              <span role="status">
                {models.length === 0 ? "暂无可用模型" : "没有匹配的模型"}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
