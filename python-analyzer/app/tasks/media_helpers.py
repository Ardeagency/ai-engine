"""Helpers para extraer URLs de imagen del jsonb media_assets — agnóstico por network."""

def extract_image_urls(media_assets, network: str) -> tuple[list[str], str]:
    """
    Devuelve (urls, kind) donde kind ∈ {'image','carousel','none'}.
    Soporta IG, TikTok (cover), YouTube (thumbnail), X (media[]), FB.
    `media_assets` puede ser dict o lista (legacy IG: array de objetos image).
    """
    if media_assets is None:
        return [], "none"

    urls: list[str] = []

    # Caso array directo (legacy IG: [{url, type:"image", permalink}])
    if isinstance(media_assets, list):
        for item in media_assets:
            if isinstance(item, dict):
                u = item.get("url") or item.get("displayUrl") or item.get("media_url_https")
                if isinstance(u, str) and u.startswith("http"):
                    urls.append(u)
            elif isinstance(item, str) and item.startswith("http"):
                urls.append(item)
        if not urls:
            return [], "none"
        return urls, ("carousel" if len(urls) > 1 else "image")

    if not isinstance(media_assets, dict):
        return [], "none"

    # archived_url PRIMERO en toda red: es nuestra copia en R2 y no expira. Las
    # URLs firmadas de fbcdn/tiktokcdn mueren en dias y devuelven 403.
    arch = media_assets.get("archived_url")
    if isinstance(arch, str) and arch.startswith("http"):
        return [arch], "image"

    if network == "instagram":
        # Single (camelCase y snake_case + cover de Reels)
        for key in ("displayUrl", "display_url", "cover_image", "thumbnail_url", "main_image_url"):
            v = media_assets.get(key)
            if isinstance(v, str) and v.startswith("http"):
                urls.append(v)
                break
        # Carousel
        for arr_key in ("images", "media_urls", "thumbnails"):
            arr = media_assets.get(arr_key)
            if isinstance(arr, list):
                for img in arr:
                    if isinstance(img, str) and img.startswith("http"):
                        urls.append(img)
                    elif isinstance(img, dict):
                        u = img.get("url") or img.get("displayUrl") or img.get("src")
                        if isinstance(u, str) and u.startswith("http"):
                            urls.append(u)

    elif network == "tiktok":
        if isinstance(media_assets.get("cover"), str):
            urls.append(media_assets["cover"])

    elif network == "youtube":
        if isinstance(media_assets.get("thumbnail"), str):
            urls.append(media_assets["thumbnail"])
        # Si hay thumbnails array, tomar la de mayor res
        elif isinstance(media_assets.get("thumbnails"), list) and media_assets["thumbnails"]:
            urls.append(media_assets["thumbnails"][-1].get("url") if isinstance(media_assets["thumbnails"][-1], dict) else media_assets["thumbnails"][-1])

    elif network == "x":
        media = media_assets.get("media") or []
        if isinstance(media, list):
            for m in media:
                if isinstance(m, dict):
                    u = m.get("media_url_https") or m.get("media_url") or m.get("url")
                    if u:
                        urls.append(u)

    elif network == "facebook":
        if isinstance(media_assets.get("displayUrl"), str):
            urls.append(media_assets["displayUrl"])
        if isinstance(media_assets.get("image"), str):
            urls.append(media_assets["image"])

    # Filtrar URLs válidas
    urls = [u for u in urls if isinstance(u, str) and u.startswith("http")]

    if not urls:
        return [], "none"
    if len(urls) == 1:
        return urls, "image"
    return urls, "carousel"


def already_described(media_assets: dict | None) -> bool:
    """Devuelve True si ya hay descripción persistida (evita re-procesar)."""
    if not isinstance(media_assets, dict):
        return False
    return bool(media_assets.get("description") or media_assets.get("descriptions"))
