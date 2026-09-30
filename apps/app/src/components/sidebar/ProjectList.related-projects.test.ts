import { describe, expect, it } from "vitest";
import { buildRelatedProjectPresentation } from "./ProjectList";

describe("buildRelatedProjectPresentation", () => {
  it("nests a related repository when the root project exists", () => {
    const presentation = buildRelatedProjectPresentation([
      { id: "hip", name: "HIP" },
      { id: "hip-website", name: "HIP Website" },
    ]);

    expect(presentation.get("hip")).toEqual({
      displayName: "HIP",
      isChild: false,
    });
    expect(presentation.get("hip-website")).toEqual({
      displayName: "Website",
      isChild: true,
    });
  });

  it("keeps a project at the root when its prefix is not another project", () => {
    const presentation = buildRelatedProjectPresentation([
      { id: "hip-website", name: "HIP Website" },
      { id: "other", name: "Other" },
    ]);

    expect(presentation.get("hip-website")).toEqual({
      displayName: "HIP Website",
      isChild: false,
    });
  });

  it("uses the closest matching parent project", () => {
    const presentation = buildRelatedProjectPresentation([
      { id: "hip", name: "HIP" },
      { id: "hip-web", name: "HIP Web" },
      { id: "hip-web-admin", name: "HIP Web Admin" },
    ]);

    expect(presentation.get("hip-web-admin")).toEqual({
      displayName: "Admin",
      isChild: true,
    });
  });

  it("does not nest unrelated names with the same prefix length", () => {
    const presentation = buildRelatedProjectPresentation([
      { id: "heep", name: "Heep" },
      { id: "other", name: "Kowl Website" },
    ]);
    expect(presentation.get("other")).toEqual({
      displayName: "Kowl Website",
      isChild: false,
    });
  });

  it("recognizes related repository names regardless of casing", () => {
    const presentation = buildRelatedProjectPresentation([
      { id: "heep", name: "heep" },
      { id: "website", name: "Heep Website v2" },
    ]);
    expect(presentation.get("website")).toEqual({
      displayName: "Website v2",
      isChild: true,
    });
  });

  it("supports separator based repository names", () => {
    const presentation = buildRelatedProjectPresentation([
      { id: "hip", name: "HIP" },
      { id: "hip-api", name: "HIP / API" },
    ]);

    expect(presentation.get("hip-api")).toEqual({
      displayName: "API",
      isChild: true,
    });
  });
});
