import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/check"],
        disallow: ["/dashboard", "/api/", "/login", "/storefront"],
      },
    ],
    sitemap: "/sitemap.xml",
  };
}
