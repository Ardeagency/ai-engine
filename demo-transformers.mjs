/**
 * Transformers v2 — extraen TODOS los campos de valor del payload Apify
 * y devuelven dos cosas:
 *   - basePost: campos de brand_posts (network, post_id, content, metrics, hashtags, mentions, etc)
 *   - platformNative: payload enriquecido para enrichment.platform_native.{network}
 */

const BRAND_ID = "a3000000-0000-0000-0000-000000000001";

// ── TIKTOK ──────────────────────────────────────────────────────────────────
export function tiktokTransform(item, entity) {
  const author = item.authorMeta || {};
  const music = item.musicMeta || {};
  const video = item.videoMeta || {};

  const basePost = {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "tiktok",
    profile_handle: entity.target_identifier,
    post_id: String(item.id),
    content: item.text || "",
    media_assets: { video_url: item.webVideoUrl, cover: video?.coverUrl, duration: video?.duration },
    metrics: {
      plays: item.playCount || 0, likes: item.diggCount || 0,
      comments: item.commentCount || 0, shares: item.shareCount || 0,
      saves: item.collectCount || 0, reposts: item.repostCount || 0,
    },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    author_display_name: author.nickName || author.name,
    mentions: (item.mentions || []).slice(0, 20),
    hashtags: (item.hashtags || []).map(h => typeof h === 'string' ? h : h.name).filter(Boolean).slice(0, 30),
    followers_snapshot: author.fans || null,
  };

  const platformNative = {
    author_snapshot: {
      username: author.uniqueId || author.name, nickname: author.nickName,
      followers: author.fans, hearts: author.heart, video_count: author.videoCount,
      verified: !!author.verified, signature: author.signature, region: author.region,
      sec_uid: author.secUid, avatar: author.avatar,
    },
    music: {
      id: music.id, title: music.title, author_name: music.authorName,
      is_original: !!music.original, duration: music.duration, play_url: music.playUrl,
    },
    detailed_mentions: (item.detailedMentions || []).map(m => ({
      id: m.id, name: m.name, nickname: m.nickName, profile_url: m.profileUrl,
    })).slice(0, 20),
    challenges: (item.challenges || []).map(c => typeof c === 'string' ? c : (c.title || c.name)).filter(Boolean).slice(0, 20),
    effect_stickers: (item.effectStickers || []).slice(0, 10),
    flags: { is_ad: !!item.isAd, is_sponsored: !!item.isSponsored, is_pinned: !!item.isPinned, is_slideshow: !!item.isSlideshow },
    region: item.region || author.region,
    text_language: item.textLanguage,
    video_meta: { duration: video?.duration, ratio: video?.ratio, original_cover: video?.originalCoverUrl, download_addr: video?.downloadAddr },
    comments_dataset_url: item.commentsDatasetUrl || null,
    create_time_iso: item.createTimeISO,
    from_profile_section: item.fromProfileSection,
  };

  return { basePost, platformNative };
}

// ── INSTAGRAM ───────────────────────────────────────────────────────────────
export function instagramTransform(item, entity) {
  const basePost = {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "instagram",
    profile_handle: entity.target_identifier,
    post_id: String(item.id || item.shortCode),
    content: item.caption || "",
    media_assets: {
      url: item.url, displayUrl: item.displayUrl, type: item.type,
      images: item.images || [], videoUrl: item.videoUrl,
      dimensions: { w: item.dimensionsWidth, h: item.dimensionsHeight },
      audio_url: item.audioUrl, video_duration: item.videoDuration,
    },
    metrics: {
      likes: item.likesCount || 0, comments: item.commentsCount || 0,
      video_views: item.videoViewCount || 0, video_plays: item.videoPlayCount || 0,
    },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    author_display_name: item.ownerFullName,
    mentions: (item.mentions || []).slice(0, 20),
    hashtags: (item.hashtags || []).slice(0, 30),
  };

  const platformNative = {
    latest_comments: (item.latestComments || []).map(c => ({
      id: c.id, text: c.text, owner: c.ownerUsername, owner_pic: c.ownerProfilePicUrl,
      timestamp: c.timestamp, likes: c.likesCount || 0, replies_count: c.repliesCount || 0,
      replies: (c.replies || []).slice(0, 5),
    })).slice(0, 10),
    first_comment: item.firstComment,
    tagged_users: (item.taggedUsers || []).map(u => typeof u === 'string' ? u : (u.username || u.full_name)).filter(Boolean).slice(0, 20),
    child_posts: (item.childPosts || []).map(c => ({ url: c.url, displayUrl: c.displayUrl, type: c.type })).slice(0, 10),
    accessibility_caption: item.alt,
    music_info: item.musicInfo || null,
    flags: { is_pinned: !!item.isPinned, is_comments_disabled: !!item.isCommentsDisabled },
    product_type: item.productType,  // FEED|REEL|IGTV
    short_code: item.shortCode,
    owner_id: item.ownerId,
    owner_username: item.ownerUsername,
  };

  return { basePost, platformNative };
}

// ── X / TWITTER ─────────────────────────────────────────────────────────────
export function xTransform(item, entity) {
  const author = item.author || {};

  const basePost = {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "x",
    profile_handle: entity.target_identifier,
    post_id: String(item.id),
    content: item.text || "",
    media_assets: { url: item.url, media: item.extendedEntities?.media || item.entities?.media },
    metrics: {
      likes: item.likeCount || 0, replies: item.replyCount || 0,
      retweets: item.retweetCount || 0, views: item.viewCount || 0,
      bookmarks: item.bookmarkCount || 0, quotes: item.quoteCount || 0,
    },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    author_display_name: author.name,
    hashtags: (item.entities?.hashtags || []).map(h => h.text).slice(0, 30),
    mentions: (item.entities?.user_mentions || []).map(m => m.screen_name).slice(0, 20),
    followers_snapshot: author.followers || null,
  };

  const platformNative = {
    author_snapshot: {
      username: author.userName, name: author.name,
      followers: author.followers, following: author.following,
      verified: !!author.isVerified, blue_verified: !!author.isBlueVerified,
      location: author.location, description: author.description,
      created_at: author.createdAt, statuses_count: author.statusesCount,
      media_count: author.mediaCount, favourites_count: author.favouritesCount,
      profile_picture: author.profilePicture, cover_picture: author.coverPicture,
    },
    conversation: {
      is_reply: !!item.isReply, in_reply_to_id: item.inReplyToId,
      in_reply_to_user_id: item.inReplyToUserId, in_reply_to_username: item.inReplyToUsername,
      conversation_id: item.conversationId,
      quoted_tweet: item.quoted_tweet ? { id: item.quoted_tweet.id, text: item.quoted_tweet.text, author: item.quoted_tweet.author?.userName } : null,
      retweeted_tweet: item.retweeted_tweet ? { id: item.retweeted_tweet.id, text: item.retweeted_tweet.text, author: item.retweeted_tweet.author?.userName } : null,
    },
    entities: {
      hashtags: (item.entities?.hashtags || []).map(h => h.text),
      mentions: (item.entities?.user_mentions || []).map(m => ({ name: m.name, screen_name: m.screen_name })),
      urls: (item.entities?.urls || []).map(u => ({ display: u.display_url, expanded: u.expanded_url })),
      symbols: item.entities?.symbols || [],
    },
    media: (item.extendedEntities?.media || []).map(m => ({
      type: m.type, url: m.media_url_https, video_info: m.video_info?.variants?.[0]?.url,
    })),
    flags: { is_pinned: !!item.isPinned, is_conversation_controlled: !!item.isConversationControlled },
    place: item.place || null,
    lang: item.lang,
    type: item.type,
  };

  return { basePost, platformNative };
}

// ── YOUTUBE ─────────────────────────────────────────────────────────────────
export function youtubeTransform(item, entity) {
  const channel = item.aboutChannelInfo || {};

  const basePost = {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "youtube",
    profile_handle: entity.target_identifier,
    post_id: String(item.id),
    content: item.title || item.text || "",
    media_assets: { url: item.url, thumbnail: item.thumbnailUrl, duration: item.duration },
    metrics: {
      views: item.viewCount || 0, likes: item.likes || 0,
      comments: item.commentsCount || 0,
    },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    author_display_name: item.channelName,
    hashtags: (item.hashtags || []).slice(0, 30),
    followers_snapshot: item.numberOfSubscribers || null,
  };

  const platformNative = {
    channel: {
      id: item.channelId, name: item.channelName, username: item.channelUsername,
      url: item.channelUrl, location: item.channelLocation || channel.channelLocation,
      total_views: item.channelTotalViews, total_videos: item.channelTotalVideos,
      subscribers: item.numberOfSubscribers, joined_date: channel.channelJoinedDate || item.channelJoinedDate,
      description: channel.channelDescription, description_links: channel.channelDescriptionLinks || [],
      avatar_url: item.channelAvatarUrl, banner_url: item.channelBannerUrl,
      is_verified: !!item.isChannelVerified,
    },
    monetization: {
      is_monetized: item.isMonetized, is_members_only: !!item.isMembersOnly,
      is_paid_content: !!item.isPaidContent, is_age_restricted: !!item.isAgeRestricted,
    },
    duration_str: item.duration,
    description: item.text,
    description_links: (item.descriptionLinks || []).slice(0, 30),
    translated_text: item.translatedText,
    translated_title: item.translatedTitle,
    subtitles: item.subtitles ? (typeof item.subtitles === 'string' ? item.subtitles.slice(0, 5000) : JSON.stringify(item.subtitles).slice(0, 5000)) : null,
    upload_date: item.date,
    type: item.type,
    flags: { from_channel_list_page: item.fromChannelListPage },
  };

  return { basePost, platformNative };
}

// ── FACEBOOK ────────────────────────────────────────────────────────────────
export function facebookTransform(item, entity) {
  const user = item.user || {};

  const basePost = {
    brand_container_id: BRAND_ID,
    entity_id: entity.id,
    network: "facebook",
    profile_handle: entity.target_identifier || item.pageName ? `@${item.pageName}` : null,
    post_id: String(item.postId),
    content: item.text || "",
    media_assets: { url: item.url, media: item.media || [], top_level_url: item.topLevelUrl },
    metrics: {
      likes: item.likes || 0, comments: item.comments || 0, shares: item.shares || 0,
      reactions_total: (item.reactionLikeCount || 0) + (item.reactionLoveCount || 0) + (item.reactionAngryCount || 0) + (item.reactionWowCount || 0) + (item.reactionHahaCount || 0) + (item.reactionSadCount || 0) + (item.reactionCareCount || 0),
    },
    is_competitor: true,
    captured_at: new Date().toISOString(),
    post_source: "competitor",
    author_display_name: user.name || item.pageName,
    followers_snapshot: null,
  };

  const platformNative = {
    reactions: {
      like: item.reactionLikeCount || 0, love: item.reactionLoveCount || 0,
      haha: item.reactionHahaCount || 0, wow: item.reactionWowCount || 0,
      angry: item.reactionAngryCount || 0, sad: item.reactionSadCount || 0,
      care: item.reactionCareCount || 0,
    },
    top_reactions_count: item.topReactionsCount,
    user: {
      id: user.id, name: user.name, profile_url: user.profileUrl, profile_pic: user.profilePic,
    },
    page: {
      id: item.facebookId, name: item.pageName, url: item.facebookUrl,
      ad_library: item.pageAdLibrary?.id ? { id: item.pageAdLibrary.id, data: item.pageAdLibrary.pamv_comms_data } : null,
    },
    text_references: (item.textReferences || []).map(r => ({
      id: r.id, name: r.short_name, url: r.url, mobile_url: r.mobileUrl,
      profile_url: r.profile_url, is_verified: !!r.is_verified,
    })).slice(0, 20),
    flags: { is_video: !!item.isVideo },
    media_summary: (item.media || []).map(m => ({
      type: m.__typename, audio: m.audio_availability, autoplay: m.autoplay_gating_result,
      animated_caption: m.animated_image_caption, accent: m.accent_color,
    })).slice(0, 5),
    feedback_id: item.feedbackId,
    timestamp_unix: item.timestamp,
  };

  return { basePost, platformNative };
}

export const TRANSFORMERS = {
  tiktok: tiktokTransform, instagram: instagramTransform,
  x: xTransform, youtube: youtubeTransform, facebook: facebookTransform,
};
