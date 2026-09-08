use serde::Deserialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct LoadedSkill {
    pub name: String,
    pub description: String,
    pub content: String,
    pub base_dir: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct SkillSnapshot {
    skills: Vec<LoadedSkill>,
}

impl SkillSnapshot {
    pub fn load(paths: &[String], disabled: &[String]) -> Result<Self, String> {
        let disabled = disabled.iter().map(String::as_str).collect::<HashSet<_>>();
        let mut directories = Vec::new();
        for raw in paths {
            let path = PathBuf::from(raw);
            if path.join("SKILL.md").is_file() {
                directories.push(path);
            } else if path.is_dir() {
                let mut children = fs::read_dir(&path)
                    .map_err(|error| error.to_string())?
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|child| child.join("SKILL.md").is_file())
                    .collect::<Vec<_>>();
                children.sort();
                directories.extend(children);
            }
        }
        let mut seen = HashSet::new();
        let mut skills = Vec::new();
        for directory in directories {
            let skill = load_skill(&directory)?;
            if seen.insert(skill.name.clone()) && !disabled.contains(skill.name.as_str()) {
                skills.push(skill);
            }
        }
        Ok(Self { skills })
    }

    pub fn system_addition(&self, selected: Option<&str>) -> Result<String, String> {
        let mut output = String::from("\n\n<available_skills>\n");
        for skill in &self.skills {
            output.push_str(&format!(
                "- {}: {} (location: {})\n",
                skill.name,
                skill.description,
                skill.base_dir.join("SKILL.md").display()
            ));
        }
        output.push_str("</available_skills>");
        if let Some(name) = selected {
            let skill = self
                .skills
                .iter()
                .find(|skill| skill.name == name)
                .ok_or("所选 Skill 不可用")?;
            output.push_str(&format!(
                "\n\n<selected_skill name=\"{}\" base_dir=\"{}\">\n{}\n</selected_skill>",
                skill.name,
                skill.base_dir.display(),
                skill.content
            ));
        }
        Ok(output)
    }

    pub fn read_resource(&self, candidate: &str) -> Result<Option<String>, String> {
        let path = Path::new(candidate);
        if !path.is_absolute() {
            return Ok(None);
        }
        let real = match path.canonicalize() {
            Ok(path) => path,
            Err(_) => return Ok(None),
        };
        let allowed = self
            .skills
            .iter()
            .any(|skill| real.starts_with(&skill.base_dir));
        if !allowed {
            return Ok(None);
        }
        let meta = fs::metadata(&real).map_err(|error| error.to_string())?;
        if !meta.is_file() || meta.len() > MAX_SKILL_FILE_BYTES {
            return Err("Skill 资源不存在或过大".into());
        }
        fs::read_to_string(real)
            .map(Some)
            .map_err(|error| error.to_string())
    }

    pub fn resource_skill_name(&self, candidate: &str) -> Option<&str> {
        let real = Path::new(candidate).canonicalize().ok()?;
        self.skills
            .iter()
            .find(|skill| real.starts_with(&skill.base_dir))
            .map(|skill| skill.name.as_str())
    }
}

#[derive(Deserialize)]
struct FrontMatter {
    name: String,
    description: String,
}

fn load_skill(directory: &Path) -> Result<LoadedSkill, String> {
    let base_dir = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let path = base_dir.join("SKILL.md");
    let meta = fs::metadata(&path).map_err(|error| error.to_string())?;
    if meta.len() > MAX_SKILL_FILE_BYTES {
        return Err("SKILL.md 超过 1 MiB".into());
    }
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
        .ok_or("SKILL.md 缺少 YAML front matter")?;
    let (yaml, _) = rest
        .split_once("\n---")
        .ok_or("SKILL.md front matter 未结束")?;
    let metadata: FrontMatter = serde_yaml::from_str(yaml).map_err(|error| error.to_string())?;
    if metadata.name.trim().is_empty() || metadata.description.trim().is_empty() {
        return Err("Skill name/description 不能为空".into());
    }
    Ok(LoadedSkill {
        name: metadata.name.trim().into(),
        description: metadata.description.trim().into(),
        content,
        base_dir,
    })
}
