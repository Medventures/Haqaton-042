"""Extract source quotes, never generate diagnoses or new medical advice."""

import re

from app.schemas import ConsultationFields
from app.workspace_models import Evidence, FieldSource, Workspace

TOPICS = (
    ("анеми", "желез", "ферритин", "гемоглобин", "эритроцит", "қаназдық", "темір"),
    ("давлен", "гиперт", "тонометр"),
    ("каш", "температур", "простуд", "орви"),
    ("диабет", "глюкоз", "сахар", "инсулин"),
)
HEADINGS = {
    "complaints": r"^(?:(?:жалобы|жалуется)\s*[:—-]|меня беспокоит\b)",
    "anamnesis": r"^(?:анамнез|из анамнеза)\s*[:—-]",
    "allergies": r"^(?:аллергии|аллергия)\s*[:—-]",
    "diagnosis": r"^(?:диагноз|предварительный диагноз)\s*[:—-]",
    "prescriptions": r"^(?:назначения|назначаю|назначено)\b",
    "recommendations": r"^(?:рекомендации|рекомендую|рекомендовано)\b",
}


def analyze_context(workspace: Workspace, focus: str) -> None:
    current = next((r for r in workspace.records if r.kind == "current"), None)
    query = focus.strip().lower()
    if not query and current:
        query = " ".join(s.text.lower() for s in current.segments)
    terms = {word[:8] for word in re.findall(r"[а-яёa-zәіңғүұқөһ]{4,}", query)}
    terms -= {"пациент", "доктор", "врач", "жалобы", "сегодня", "котор", "сейчас"}
    for group in TOPICS:
        if any(term in query for term in group):
            terms.update(group)

    workspace.evidence = []
    workspace.previous_recommendations = []
    workspace.field_sources = []
    values: dict[str, list[str]] = {key: [] for key in HEADINGS}
    for record in workspace.records:
        for segment in record.segments:
            text = segment.text
            lower = text.lower()
            matched = sorted(term for term in terms if term in lower)
            evidence = Evidence(
                record_id=record.id,
                segment_id=segment.id,
                quote=text,
                reason="Совпадение по теме: " + ", ".join(matched[:4]),
            )
            if record.kind == "history":
                if matched:
                    workspace.evidence.append(evidence)
                    if segment.role == "doctor" and re.search(
                        r"\b(?:рекоменд|назнач|приним|контрол|повтор|сдайте)", lower
                    ):
                        workspace.previous_recommendations.append(evidence)
                continue
            # Unknown speakers and questions are not attributed to the patient or doctor.
            if segment.role == "unknown" or "?" in text:
                continue
            for key, pattern in HEADINGS.items():
                if re.search(pattern, lower) and (
                    segment.role == "doctor" or key in {"complaints", "anamnesis", "allergies"}
                ):
                    values[key].append(text)
                    workspace.field_sources.append(
                        FieldSource(
                            **evidence.model_dump(),
                            field=key,
                        )
                    )
                    break
            else:
                if segment.role == "patient":
                    # Keep free speech as history; no disease/medication inference.
                    values["anamnesis"].append(text)
                    workspace.field_sources.append(
                        FieldSource(**evidence.model_dump(), field="anamnesis")
                    )
    workspace.fields = ConsultationFields(
        **{key: "\n".join(lines)[:10000] or None for key, lines in values.items()}
    )
    workspace.focus = focus.strip()
    workspace.generated = True
    workspace.context_stale = False
    workspace.confirmed_revision = None
