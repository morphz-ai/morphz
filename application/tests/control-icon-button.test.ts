import test from "node:test";
import assert from "node:assert/strict";
import {
  createElement,
  createRef,
  type ComponentProps,
  type ReactNode,
  type RefCallback,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChevronDown,
  Maximize2,
  MessageSquareText,
  Minimize2,
  PanelLeft,
  PanelRight,
  Pin,
} from "lucide-react";
import {
  assertControlIconRole,
  ControlIcon,
  controlIcons,
  controlRoleIcons,
  type ControlIconForRole,
  type ControlIconId,
  type ControlRole,
} from "../apps/web/src/design/control-icons.js";
import {
  IconButton,
  type IconButtonProps,
} from "../apps/web/src/ui/IconButton.js";
import { SidebarToggle } from "../apps/web/src/SidebarToggle.js";
import {
  ComposerToolButtons,
  type ComposerTool,
} from "../apps/web/src/ComposerToolButtons.js";
import { ExchangeControls } from "../apps/web/src/ExchangePanel.js";
import { ComposerOptions } from "../apps/web/src/ComposerOptions.js";

// Explicit bb8a1f35 glyph/markup oracles, not a new visual specification.
// SSR compares emitted bytes and prop forwarding; it does not run layout
// effects or prove mounted DOM identity, focus, hover or ref cleanup timing.
const originalIcons = {
  "panel-left": PanelLeft,
  "panel-right": PanelRight,
  "message-square-text": MessageSquareText,
  maximize: Maximize2,
  minimize: Minimize2,
  pin: Pin,
  "chevron-down": ChevronDown,
} as const;
const noop = () => {};
const render = (node: ReactNode) => renderToStaticMarkup(node);
type SidebarProps = ComponentProps<typeof SidebarToggle>;
function originalSidebar(props: SidebarProps) {
  const { side, expanded, controls, className = "", title, onClick } = props;
  const label =
    side === "left"
      ? expanded
        ? "隐藏侧边栏"
        : "显示侧边栏"
      : expanded
        ? "隐藏右侧栏"
        : "显示右侧栏";
  return createElement(
    "button",
    {
      className: `icon-button sidebar-visibility-toggle ${className}`,
      "aria-label": label,
      title: title ?? label,
      "aria-expanded": expanded,
      "aria-controls": controls,
      onClick,
    },
    createElement(side === "left" ? PanelLeft : PanelRight),
  );
}
function originalTools(options: ComposerTool[], unread?: boolean) {
  return options.map((option) =>
    createElement(
      "button",
      {
        key: option.id ?? option.label,
        className:
          "icon-button composer-tool" +
          (option.groupStart ? " composer-tool-group-start" : "") +
          (option.reserveOnly ? " composer-tool-reserved" : ""),
        "aria-label": option.label,
        "aria-hidden": option.reserveOnly || undefined,
        "aria-pressed": option.pressed,
        "aria-description":
          unread && option.id === "history-visibility" ? "有新回复" : undefined,
        title: option.title ?? option.label,
        disabled: option.disabled || option.reserveOnly,
        onClick: option.onSelect,
      },
      createElement(originalIcons[option.iconId]),
      unread &&
        option.id === "history-visibility" &&
        createElement("span", {
          className: "composer-unread",
          "aria-hidden": "true",
        }),
    ),
  );
}
function originalExchange(props: ComponentProps<typeof ExchangeControls>) {
  const {
    conversationVisible,
    historyVisible,
    pinned,
    unread,
    onInteraction,
    onPin,
    onHide,
  } = props;
  const secondary: ComposerTool[] = [
    {
      id: "history-size",
      label: historyVisible ? "返回工作内容" : "展开完整记录",
      iconId: historyVisible ? "minimize" : "maximize",
      pressed: historyVisible,
      onSelect: () => onInteraction(historyVisible ? "recent" : "history"),
    },
    {
      id: "pin",
      label: pinned ? "取消固定输入框" : "固定输入框",
      iconId: "pin",
      pressed: pinned,
      onSelect: onPin,
    },
  ];
  return createElement(
    "div",
    {
      className: "exchange-view-tools",
      role: "group",
      "aria-label": "交流面板操作",
    },
    originalTools(
      [
        {
          id: "history-visibility",
          label: conversationVisible ? "收起交流记录" : "查看交流记录",
          iconId: "message-square-text",
          pressed: conversationVisible,
          onSelect: () =>
            onInteraction(conversationVisible ? "input" : "recent"),
        },
      ],
      unread,
    ),
    originalTools(secondary),
    createElement(
      "button",
      {
        className: "icon-button",
        "aria-label": "收起 AI 输入框",
        title: "收起 AI 输入框",
        onClick: onHide,
      },
      createElement(ChevronDown),
    ),
  );
}

test("seven registered glyph constructors and both role lists are the exact old Lucide choices", () => {
  assert.deepEqual(Object.keys(controlIcons), Object.keys(originalIcons));
  for (const name of Object.keys(originalIcons) as ControlIconId[]) {
    assert.equal(controlIcons[name], originalIcons[name]);
    assert.equal(ControlIcon({ name }).type, originalIcons[name]);
    assert.equal(
      render(createElement(ControlIcon, { name })),
      render(createElement(originalIcons[name])),
    );
  }
  assert.deepEqual(controlRoleIcons, {
    "sidebar-visibility": ["panel-left", "panel-right"],
    "exchange-operation": [
      "message-square-text",
      "maximize",
      "minimize",
      "pin",
      "chevron-down",
    ],
  });
  assert.match(
    render(createElement(ControlIcon, { name: "panel-left" })),
    /lucide-sidebar/,
  );
});
test("unknown/prototype icons, unknown/prototype roles and all cross-role pairs are rejected", () => {
  for (const role of Object.keys(controlRoleIcons) as ControlRole[])
    for (const name of Object.keys(controlIcons) as ControlIconId[])
      if ((controlRoleIcons[role] as readonly string[]).includes(name))
        assert.doesNotThrow(() => assertControlIconRole(role, name));
      else assert.throws(() => assertControlIconRole(role, name), TypeError);
  for (const value of [
    "unknown",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "",
    null,
    undefined,
  ]) {
    assert.throws(
      () => ControlIcon({ name: value as ControlIconId }),
      TypeError,
    );
    assert.throws(
      () => assertControlIconRole("exchange-operation", value as ControlIconId),
      TypeError,
    );
    assert.throws(
      () => assertControlIconRole(value as ControlRole, "pin"),
      TypeError,
    );
  }
  assert.throws(
    () =>
      render(
        createElement(IconButton, {
          controlRole: "sidebar-visibility",
          iconId: "pin",
        } as unknown as IconButtonProps),
      ),
    TypeError,
  );
});
test("primitive adds no button attributes or defaults and preserves explicitly provided native attributes", () => {
  const bare = render(
    createElement(IconButton, {
      controlRole: "exchange-operation",
      iconId: "pin",
    }),
  );
  assert.equal(bare, render(createElement("button", null, createElement(Pin))));
  assert.equal(bare.slice(0, bare.indexOf(">") + 1), "<button>");
  const decoration = createElement("span", {
    className: "composer-unread",
    "aria-hidden": "true",
  });
  for (const pressed of [undefined, false, true] as const)
    for (const title of [undefined, "", "原提示"])
      for (const disabled of [undefined, false, true] as const) {
        const native = {
          id: "control",
          className: "icon-button",
          title,
          "aria-label": "原名称",
          "aria-pressed": pressed,
          disabled,
          type: "reset" as const,
          tabIndex: -1,
          onClick: noop,
        };
        const props: IconButtonProps = {
          controlRole: "exchange-operation",
          iconId: "pin",
          afterIcon: decoration,
          ...native,
        };
        assert.equal(
          render(createElement(IconButton, props)),
          render(
            createElement("button", native, createElement(Pin), decoration),
          ),
        );
      }
});
test("sidebar emitted DOM is identical for both sides, expanded states, classes, controls and empty/default titles", () => {
  let comparisons = 0;
  for (const side of ["left", "right"] as const)
    for (const expanded of [false, true])
      for (const className of [undefined, "", "inspector-toggle"])
        for (const title of [undefined, "", "活动：实际标题"])
          for (const controls of ["navigation", "morphz-subject"]) {
            const props = {
              side,
              expanded,
              className,
              title,
              controls,
              onClick: noop,
            };
            assert.equal(
              render(createElement(SidebarToggle, props)),
              render(originalSidebar(props)),
            );
            comparisons++;
          }
  assert.equal(comparisons, 72);
});
test("all 7290 direct-tool icon/pressed/disabled/reserved/group/unread/key/title combinations keep original DOM", () => {
  let comparisons = 0;
  for (const iconId of controlRoleIcons["exchange-operation"])
    for (const pressed of [undefined, false, true] as const)
      for (const disabled of [undefined, false, true] as const)
        for (const reserveOnly of [undefined, false, true] as const)
          for (const groupStart of [undefined, false, true] as const)
            for (const unread of [false, true])
              for (const id of [undefined, "", "history-visibility"])
                for (const title of [undefined, "", "完整提示"]) {
                  const option: ComposerTool = {
                    id,
                    iconId,
                    label: "原操作",
                    pressed,
                    disabled,
                    reserveOnly,
                    groupStart,
                    title,
                    onSelect: noop,
                  };
                  assert.equal(
                    render(
                      createElement(ComposerToolButtons, {
                        options: [option],
                        unread,
                      }),
                    ),
                    render(originalTools([option], unread)),
                  );
                  comparisons++;
                }
  assert.equal(comparisons, 7290);
});
test("stable component type, original id/nullish keys, handlers and object/callback refs pass through without wrapping", () => {
  for (const id of [
    "history-size",
    "history-visibility",
    "pin",
    "",
    undefined,
  ]) {
    const onSelect = () => {};
    const first = ComposerToolButtons({
      options: [{ id, label: "旧标签", iconId: "pin", onSelect }],
      unread: false,
    })[0]!;
    const next = ComposerToolButtons({
      options: [
        { id, label: "新标签", iconId: "pin", pressed: true, onSelect },
      ],
      unread: true,
    })[0]!;
    assert.equal(first.type, IconButton);
    assert.equal(next.type, IconButton);
    assert.equal(first.key, id ?? "旧标签");
    assert.equal(next.key, id ?? "新标签");
    assert.equal(IconButton(first.props).props.onClick, onSelect);
    assert.equal(IconButton(next.props).props.onClick, onSelect);
  }
  for (const side of ["left", "right"] as const)
    for (const expanded of [false, true])
      assert.equal(
        SidebarToggle({ side, expanded, controls: "sidebar", onClick: noop })
          .type,
        IconButton,
      );
  const object = createRef<HTMLButtonElement>();
  const cleanup = () => {};
  const callback: RefCallback<HTMLButtonElement> = () => cleanup;
  for (const ref of [object, callback]) {
    const button = IconButton({
      controlRole: "exchange-operation",
      iconId: "chevron-down",
      ref,
    });
    assert.equal(button.type, "button");
    assert.equal(button.props.ref, ref);
  }
});
test("16 actual ExchangeControls SSR states and compact menu glyph adapters retain original markup", () => {
  let wide = 0,
    menus = 0;
  for (const conversationVisible of [false, true])
    for (const historyVisible of [false, true])
      for (const pinned of [false, true])
        for (const unread of [false, true]) {
          const props = {
            conversationVisible,
            historyVisible,
            pinned,
            unread,
            onInteraction: noop,
            onPin: noop,
            onHide: noop,
          };
          assert.equal(
            render(createElement(ExchangeControls, props)),
            render(originalExchange(props)),
          );
          wide++;
          const options: {
            label: string;
            iconId: ControlIconForRole<"exchange-operation">;
            pressed: boolean;
            onSelect: () => void;
          }[] = [
            {
              label: historyVisible ? "返回工作内容" : "展开完整记录",
              iconId: historyVisible ? "minimize" : "maximize",
              pressed: historyVisible,
              onSelect: noop,
            },
            {
              label: pinned ? "取消固定输入框" : "固定输入框",
              iconId: "pin",
              pressed: pinned,
              onSelect: noop,
            },
          ];
          const common = {
            label: "更多交流选项",
            menuLabel: "交流选项",
            below: conversationVisible,
          };
          assert.equal(
            render(
              createElement(ComposerOptions, {
                ...common,
                options: options.map(({ iconId, ...option }) => ({
                  ...option,
                  icon: createElement(ControlIcon, { name: iconId }),
                })),
              }),
            ),
            render(
              createElement(ComposerOptions, {
                ...common,
                options: options.map(({ iconId, ...option }) => ({
                  ...option,
                  icon: createElement(originalIcons[iconId]),
                })),
              }),
            ),
          );
          menus++;
        }
  assert.equal(wide, 16);
  assert.equal(menus, 16);
});

// The normal typecheck verifies these rejected callsite contracts too. None is
// rendered or executed; invalid legacy menu ReactNode inputs remain legal in
// ComposerOptions, which is deliberately outside this primitive migration.
if (false) {
  // @ts-expect-error Sidebar glyph is not an exchange operation.
  const badRole: IconButtonProps = {
    controlRole: "exchange-operation",
    iconId: "panel-left",
  };
  const badIcon: IconButtonProps = {
    controlRole: "exchange-operation",
    // @ts-expect-error Only the seven exact registered identities are legal.
    iconId: "unknown",
  };
  const badChildren: IconButtonProps = {
    controlRole: "exchange-operation",
    iconId: "pin",
    // @ts-expect-error Arbitrary children cannot be an alternative icon interface.
    children: createElement("svg"),
  };
  const badTool: ComposerTool = {
    label: "操作",
    // @ts-expect-error Direct tools accept registered role-constrained icon IDs, not ReactNode icons.
    icon: createElement(Pin),
    onSelect: noop,
  };
  void [badRole, badIcon, badChildren, badTool];
}
