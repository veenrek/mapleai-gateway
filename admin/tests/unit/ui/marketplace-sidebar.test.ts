import test from "node:test";
import assert from "node:assert/strict";

import {
  HIDEABLE_SIDEBAR_ITEM_IDS,
  SIDEBAR_SECTIONS,
} from "../../../src/shared/constants/sidebarVisibility";

test("marketplace appears in hideable sidebar items", () => {
  assert.ok((HIDEABLE_SIDEBAR_ITEM_IDS as readonly string[]).includes("marketplace"));
});

test("marketplace is linked from OmniProxy sidebar section", () => {
  const omniProxy = SIDEBAR_SECTIONS.find((section) => section.id === "omni-proxy");
  assert.ok(omniProxy);

  const items = omniProxy.children.flatMap((child) =>
    "type" in child && child.type === "group" ? child.items : [child]
  );
  const marketplace = items.find((item) => item.id === "marketplace");
  assert.ok(marketplace);
  assert.equal(marketplace.href, "/dashboard/marketplace");
  assert.equal(marketplace.labelFallback, "Marketplace");
});
