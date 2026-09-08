use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const TAG_PALETTE: &[&str] = &[
    "#e5484d", "#f5a623", "#f2c744", "#3cb371", "#0d9488", "#3b82f6", "#8b5cf6", "#ec4899",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDef {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone)]
pub struct Annotation {
    pub id: String,
    pub tag_id: String,
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone)]
pub struct QuoteSource {
    pub card_from: usize,
    pub bundle_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct InboxMetadata {
    pub tags: Vec<TagDef>,
    pub annotations: Vec<Annotation>,
    pub quote_sources: Vec<QuoteSource>,
}

#[derive(Debug, Clone)]
pub struct DecodedInbox {
    pub markdown: String,
    pub metadata: InboxMetadata,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TextChange {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

pub fn decode_inbox(input: &str) -> DecodedInbox {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let (first, body) = input.split_once('\n').unwrap_or((input, ""));
    let first = first.trim_end_matches('\r');
    let mut warnings = Vec::new();
    let mut tags = Vec::new();
    let body = if let Some(defs) = first
        .strip_prefix("<!-- floatnote:tags:v2 ")
        .and_then(|line| line.strip_suffix(" -->"))
    {
        let entry =
            Regex::new(r#"([a-z0-9-]+)="((?:\\.|[^"])*)"\|c=(#[0-9a-fA-F]{3,8})(?:; |$)"#).unwrap();
        let mut consumed = 0;
        for cap in entry.captures_iter(defs) {
            let found = cap.get(0).unwrap();
            if found.start() != consumed {
                warnings.push("malformed-metadata".into());
            }
            tags.push(TagDef {
                id: cap[1].into(),
                name: unescape(&cap[2]),
                color: cap[3].into(),
            });
            consumed = found.end();
        }
        if consumed != defs.len() {
            warnings.push("malformed-metadata".into());
        }
        body
    } else if first == "<!-- floatnote:tags:v2 -->" || first.starts_with("<!-- floatnote-tags:") {
        body
    } else if first.starts_with("<!-- floatnote:tags:v2") {
        warnings.push("malformed-metadata".into());
        body
    } else {
        input
    };

    let marker = Regex::new(r"<!--\s*floatnote(?::|-tags:)[^\r\n]*?-->").unwrap();
    let start_re =
        Regex::new(r"^<!-- floatnote:ann:v2 id=([a-z0-9-]+) tag=([a-z0-9-]+) start -->$").unwrap();
    let end_re = Regex::new(r"^<!-- floatnote:ann:v2 id=([a-z0-9-]+) end -->$").unwrap();
    let bid_re = Regex::new(r"^<!-- floatnote:bid=([^>]*?) -->$").unwrap();
    let mut clean = String::new();
    let mut source = 0;
    let mut starts = HashMap::new();
    let mut ends = HashMap::new();
    let mut invalid = HashSet::new();
    let mut quote_sources = Vec::new();
    for found in marker.find_iter(body) {
        clean.push_str(&body[source..found.start()]);
        let offset = utf16_len(&clean);
        let value = found.as_str();
        if let Some(cap) = start_re.captures(value) {
            if starts
                .insert(cap[1].to_string(), (cap[2].to_string(), offset))
                .is_some()
            {
                invalid.insert(cap[1].to_string());
                warnings.push("duplicate-marker".into());
            }
        } else if let Some(cap) = end_re.captures(value) {
            if ends.insert(cap[1].to_string(), offset).is_some() {
                invalid.insert(cap[1].to_string());
                warnings.push("duplicate-marker".into());
            }
        } else if let Some(cap) = bid_re.captures(value) {
            let line_byte = clean.rfind('\n').map_or(0, |index| index + 1);
            quote_sources.push(QuoteSource {
                card_from: utf16_len(&clean[..line_byte]),
                bundle_id: cap[1].into(),
            });
        } else {
            warnings.push("malformed-metadata".into());
        }
        source = found.end();
    }
    clean.push_str(&body[source..]);
    let malformed = Regex::new(r"<!--\s*floatnote(?::|-tags:)[^\r\n]*").unwrap();
    if malformed.is_match(&clean) {
        warnings.push("malformed-metadata".into());
        clean = malformed.replace_all(&clean, "").into_owned();
    }
    let known = tags
        .iter()
        .map(|tag| tag.id.as_str())
        .collect::<HashSet<_>>();
    let mut annotations = Vec::new();
    let ids = starts
        .keys()
        .chain(ends.keys())
        .cloned()
        .collect::<HashSet<_>>();
    for id in ids {
        let Some((tag_id, from)) = starts.get(&id) else {
            warnings.push("orphan-marker".into());
            continue;
        };
        let Some(to) = ends.get(&id) else {
            warnings.push("orphan-marker".into());
            continue;
        };
        if invalid.contains(&id) {
            continue;
        }
        if !known.contains(tag_id.as_str()) {
            warnings.push("unknown-tag".into());
            continue;
        }
        if from >= to {
            warnings.push("invalid-range".into());
            continue;
        }
        annotations.push(Annotation {
            id,
            tag_id: tag_id.clone(),
            from: *from,
            to: *to,
        });
    }
    annotations.sort_by_key(|item| (item.from, item.to));
    let mut canonical: Vec<Annotation> = Vec::new();
    for annotation in annotations {
        if let Some(previous) = canonical
            .iter_mut()
            .rev()
            .find(|item| item.tag_id == annotation.tag_id)
        {
            if annotation.from <= previous.to {
                previous.to = previous.to.max(annotation.to);
                continue;
            }
        }
        canonical.push(annotation);
    }
    DecodedInbox {
        markdown: clean,
        metadata: InboxMetadata {
            tags,
            annotations: canonical,
            quote_sources,
        },
        warnings,
    }
}

pub fn encode_inbox(markdown: &str, metadata: &InboxMetadata) -> String {
    #[derive(Eq, PartialEq, Ord, PartialOrd)]
    enum Kind {
        End,
        Start,
        Quote,
    }
    let valid_tags = metadata
        .tags
        .iter()
        .filter(|tag| valid_id(&tag.id) && valid_tag_name(&tag.name) && valid_color(&tag.color))
        .map(|tag| tag.id.as_str())
        .collect::<HashSet<_>>();
    let order = metadata
        .tags
        .iter()
        .enumerate()
        .map(|(index, tag)| (tag.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut events: Vec<(usize, Kind, usize, String, String)> = Vec::new();
    let length = utf16_len(markdown);
    for annotation in &metadata.annotations {
        if !valid_id(&annotation.id)
            || !valid_tags.contains(annotation.tag_id.as_str())
            || annotation.from >= annotation.to
            || annotation.to > length
        {
            continue;
        }
        let tag_order = *order.get(annotation.tag_id.as_str()).unwrap_or(&usize::MAX);
        events.push((
            annotation.from,
            Kind::Start,
            tag_order,
            annotation.id.clone(),
            format!(
                "<!-- floatnote:ann:v2 id={} tag={} start -->",
                annotation.id, annotation.tag_id
            ),
        ));
        events.push((
            annotation.to,
            Kind::End,
            tag_order,
            annotation.id.clone(),
            format!("<!-- floatnote:ann:v2 id={} end -->", annotation.id),
        ));
    }
    for source in &metadata.quote_sources {
        if source.card_from > length
            || !source
                .bundle_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            continue;
        }
        let byte = byte_at_utf16(markdown, source.card_from);
        let line_end = markdown[byte..]
            .find('\n')
            .map_or(length, |index| utf16_len(&markdown[..byte + index]));
        events.push((
            line_end,
            Kind::Quote,
            usize::MAX,
            source.bundle_id.clone(),
            format!("<!-- floatnote:bid={} -->", source.bundle_id),
        ));
    }
    events.sort_by(|a, b| (&a.0, &a.1, &a.2, &a.3).cmp(&(&b.0, &b.1, &b.2, &b.3)));
    let mut output = String::new();
    let mut offset = 0;
    for (pos, _, _, _, marker) in events {
        let byte = byte_at_utf16(markdown, pos);
        output.push_str(&markdown[offset..byte]);
        output.push_str(&marker);
        offset = byte;
    }
    output.push_str(&markdown[offset..]);
    let defs = metadata
        .tags
        .iter()
        .filter(|tag| valid_tags.contains(tag.id.as_str()))
        .map(|tag| format!("{}=\"{}\"|c={}", tag.id, escape(&tag.name), tag.color))
        .collect::<Vec<_>>()
        .join("; ");
    if defs.is_empty() {
        output
    } else {
        format!("<!-- floatnote:tags:v2 {defs} -->\n{output}")
    }
}

pub fn locate_changes(
    markdown: &str,
    edits: &[(String, String)],
) -> Result<Vec<TextChange>, String> {
    if edits.is_empty() {
        return Err("edits 至少需要一项替换".into());
    }
    let mut changes = Vec::new();
    for (old, new) in edits {
        if old.is_empty() {
            return Err("oldText 不能为空".into());
        }
        let mut matches = markdown.match_indices(old);
        let first = matches.next().ok_or("未找到要替换的文本")?;
        if matches.next().is_some() {
            return Err("要替换的文本不唯一，请补充更多上下文".into());
        }
        changes.push(TextChange {
            from: utf16_len(&markdown[..first.0]),
            to: utf16_len(&markdown[..first.0 + old.len()]),
            insert: new.clone(),
        });
    }
    changes.sort_by_key(|change| (change.from, change.to));
    for pair in changes.windows(2) {
        if pair[1].from < pair[0].to {
            return Err("多个 edits 不能重叠或嵌套".into());
        }
    }
    Ok(changes)
}

pub fn apply_changes(markdown: &str, changes: &[TextChange]) -> String {
    let mut output = markdown.to_string();
    for change in changes.iter().rev() {
        let from = byte_at_utf16(&output, change.from);
        let to = byte_at_utf16(&output, change.to);
        output.replace_range(from..to, &change.insert);
    }
    output
}

pub fn map_annotations(annotations: &[Annotation], changes: &[TextChange]) -> Vec<Annotation> {
    annotations
        .iter()
        .filter_map(|item| {
            let from = map_position(item.from, changes, 1);
            let to = map_position(item.to, changes, -1);
            (from < to).then(|| Annotation {
                id: item.id.clone(),
                tag_id: item.tag_id.clone(),
                from,
                to,
            })
        })
        .collect()
}

pub fn map_quote_sources(
    old: &str,
    new: &str,
    sources: &[QuoteSource],
    changes: &[TextChange],
) -> Vec<QuoteSource> {
    sources
        .iter()
        .filter_map(|source| {
            let old_byte = byte_at_utf16(old, source.card_from);
            let line_start_byte = old[..old_byte].rfind('\n').map_or(0, |index| index + 1);
            let line_end_byte = old[line_start_byte..]
                .find('\n')
                .map_or(old.len(), |index| line_start_byte + index);
            let old_from = utf16_len(&old[..line_start_byte]);
            let old_to = utf16_len(&old[..line_end_byte]);
            let search_from = map_position(old_from, changes, -1);
            let search_to = map_position(old_to, changes, 1);
            if search_from >= search_to {
                return None;
            }
            let from_byte = byte_at_utf16(new, search_from);
            let to_byte = byte_at_utf16(new, search_to);
            let segment = &new[from_byte..to_byte];
            let mut cursor = from_byte;
            for line in segment.split_inclusive('\n') {
                if line
                    .trim_end_matches(['\r', '\n'])
                    .starts_with("> [!quote]")
                {
                    return Some(QuoteSource {
                        card_from: utf16_len(&new[..cursor]),
                        bundle_id: source.bundle_id.clone(),
                    });
                }
                cursor += line.len();
            }
            None
        })
        .collect()
}

pub fn exact_text_range(
    markdown: &str,
    exact: &str,
    prefix: Option<&str>,
    suffix: Option<&str>,
) -> Result<(usize, usize), String> {
    if exact.is_empty() {
        return Err("目标文本不能为空".into());
    }
    let matches = markdown
        .match_indices(exact)
        .filter(|(index, _)| {
            let before = &markdown[..*index];
            let after = &markdown[*index + exact.len()..];
            prefix.is_none_or(|value| before.ends_with(value))
                && suffix.is_none_or(|value| after.starts_with(value))
        })
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return Err("定位文本失败：not-found".into());
    }
    if matches.len() > 1 {
        return Err("定位文本失败：ambiguous".into());
    }
    let byte = matches[0].0;
    Ok((
        utf16_len(&markdown[..byte]),
        utf16_len(&markdown[..byte + exact.len()]),
    ))
}

pub fn add_annotation(
    annotations: &[Annotation],
    tag_id: &str,
    from: usize,
    to: usize,
) -> Vec<Annotation> {
    let mut result = annotations.to_vec();
    let mut merged_from = from;
    let mut merged_to = to;
    let mut retained = None;
    result.retain(|item| {
        if item.tag_id == tag_id && item.from <= merged_to && item.to >= merged_from {
            merged_from = merged_from.min(item.from);
            merged_to = merged_to.max(item.to);
            retained.get_or_insert_with(|| item.id.clone());
            false
        } else {
            true
        }
    });
    result.push(Annotation {
        id: retained
            .unwrap_or_else(|| format!("ann-ai-{}", crate::agent::session::new_id_for_agent())),
        tag_id: tag_id.into(),
        from: merged_from,
        to: merged_to,
    });
    result.sort_by_key(|item| (item.from, item.to));
    result
}

pub fn remove_annotation(
    annotations: &[Annotation],
    tag_id: &str,
    from: usize,
    to: usize,
) -> Vec<Annotation> {
    let mut result = Vec::new();
    for item in annotations {
        if item.tag_id != tag_id || to <= item.from || from >= item.to {
            result.push(item.clone());
            continue;
        }
        if item.from < from {
            result.push(Annotation {
                to: from,
                ..item.clone()
            });
        }
        if to < item.to {
            result.push(Annotation {
                id: format!("ann-ai-{}", crate::agent::session::new_id_for_agent()),
                from: to,
                ..item.clone()
            });
        }
    }
    result.sort_by_key(|item| (item.from, item.to));
    result
}

pub fn free_colors(tags: &[TagDef], excluding: Option<&str>) -> Vec<String> {
    let used = tags
        .iter()
        .filter(|tag| excluding != Some(tag.id.as_str()))
        .map(|tag| tag.color.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    TAG_PALETTE
        .iter()
        .filter(|color| !used.contains(&color.to_ascii_lowercase()))
        .map(|color| (*color).into())
        .collect()
}

pub fn valid_tag_name(name: &str) -> bool {
    !name.trim().is_empty() && name.encode_utf16().count() <= 80 && !name.contains(['\r', '\n'])
}
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}
pub fn byte_at_utf16(text: &str, offset: usize) -> usize {
    if offset == 0 {
        return 0;
    }
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units >= offset {
            return byte;
        }
        units += ch.len_utf16();
    }
    text.len()
}
fn map_position(pos: usize, changes: &[TextChange], assoc: i8) -> usize {
    let mut delta: isize = 0;
    for change in changes {
        let inserted = utf16_len(&change.insert);
        let removed = change.to - change.from;
        if pos < change.from || (pos == change.from && removed > 0 && assoc < 0) {
            break;
        }
        if pos > change.to || (pos == change.to && removed > 0 && assoc > 0) {
            delta += inserted as isize - removed as isize;
            continue;
        }
        if removed == 0 && pos == change.from {
            return ((pos as isize) + delta + if assoc > 0 { inserted as isize } else { 0 })
                as usize;
        }
        return ((change.from as isize) + delta + if assoc > 0 { inserted as isize } else { 0 })
            as usize;
    }
    ((pos as isize) + delta).max(0) as usize
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}
fn valid_color(value: &str) -> bool {
    Regex::new(r"^#[0-9a-fA-F]{3,8}$").unwrap().is_match(value)
}
fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
fn unescape(value: &str) -> String {
    Regex::new(r#"\\([\\"])"#)
        .unwrap()
        .replace_all(value, "$1")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    #[test]
    fn codec_keeps_utf16_annotation_offsets() {
        let raw = "<!-- floatnote:tags:v2 t=\"标签\"|c=#e5484d -->\n你<!-- floatnote:ann:v2 id=a tag=t start -->好😀<!-- floatnote:ann:v2 id=a end -->";
        let decoded = decode_inbox(raw);
        assert_eq!(decoded.markdown, "你好😀");
        assert_eq!(
            (
                decoded.metadata.annotations[0].from,
                decoded.metadata.annotations[0].to
            ),
            (1, 4)
        );
        assert_eq!(
            decode_inbox(&encode_inbox(&decoded.markdown, &decoded.metadata)).markdown,
            decoded.markdown
        );
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityFixture {
        raw: String,
        markdown: String,
        tags: Vec<TagDefWire>,
        annotations: Vec<AnnotationWire>,
        quote_sources: Vec<QuoteWire>,
    }
    #[derive(Deserialize)]
    struct TagDefWire {
        id: String,
        name: String,
        color: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AnnotationWire {
        id: String,
        tag_id: String,
        from: usize,
        to: usize,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct QuoteWire {
        card_from: usize,
        bundle_id: String,
    }

    #[test]
    fn matches_the_shared_frontend_codec_fixtures() {
        let fixtures: Vec<ParityFixture> = serde_json::from_str(include_str!(
            "../../../shared/note-logic/fixtures/agent-parity.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let decoded = decode_inbox(&fixture.raw);
            assert_eq!(decoded.markdown, fixture.markdown);
            assert_eq!(
                decoded
                    .metadata
                    .tags
                    .iter()
                    .map(|tag| (&tag.id, &tag.name, &tag.color))
                    .collect::<Vec<_>>(),
                fixture
                    .tags
                    .iter()
                    .map(|tag| (&tag.id, &tag.name, &tag.color))
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                decoded
                    .metadata
                    .annotations
                    .iter()
                    .map(|item| (&item.id, &item.tag_id, item.from, item.to))
                    .collect::<Vec<_>>(),
                fixture
                    .annotations
                    .iter()
                    .map(|item| (&item.id, &item.tag_id, item.from, item.to))
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                decoded
                    .metadata
                    .quote_sources
                    .iter()
                    .map(|item| (item.card_from, &item.bundle_id))
                    .collect::<Vec<_>>(),
                fixture
                    .quote_sources
                    .iter()
                    .map(|item| (item.card_from, &item.bundle_id))
                    .collect::<Vec<_>>()
            );
        }
    }
}
