import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from pydantic import Field, model_validator

from app.schemas import RevisionRequest, Schema


class CalculationInput(RevisionRequest):
    mode: Literal["bmi", "weight_rule", "iron_deficit"] = "bmi"
    height_cm: Decimal = Field(ge=30, le=300, allow_inf_nan=False, decimal_places=2)
    weight_kg: Decimal = Field(ge=1, le=1000, allow_inf_nan=False, decimal_places=3)
    medication: str = Field(default="", max_length=200)
    rate_mg_kg: Decimal | None = Field(default=None, gt=0, le=10000, allow_inf_nan=False)
    basis: Literal["per_dose", "per_day"] = "per_dose"
    maximum_mg: Decimal | None = Field(default=None, gt=0, le=1000000, allow_inf_nan=False)
    rule_source: str = Field(default="", max_length=1000)
    reviewed: bool = False
    hb_g_l: Decimal | None = Field(default=None, gt=0, le=250, allow_inf_nan=False)
    target_hb_g_l: Decimal | None = Field(default=None, gt=0, le=250, allow_inf_nan=False)
    iron_store_mg: Decimal | None = Field(default=None, ge=0, le=3000, allow_inf_nan=False)

    @model_validator(mode="after")
    def medication_rule(self):
        if self.mode == "iron_deficit":
            if self.hb_g_l is None or self.target_hb_g_l is None or self.iron_store_mg is None:
                raise ValueError("Hb, target Hb and iron stores are required")
            if self.hb_g_l >= self.target_hb_g_l:
                raise ValueError("No Hb deficit below target; physician review required")
        if self.mode == "weight_rule" and self.rate_mg_kg is None:
            raise ValueError("Dose rule required")
        if self.rate_mg_kg is not None and (
            not self.medication.strip() or not self.rule_source.strip()
        ):
            raise ValueError("Medication and physician rule source are required")
        if self.mode == "weight_rule" and self.medication.strip() and self.rate_mg_kg is None:
            raise ValueError("Medication requires a dose rule")
        return self


class CalculationResult(Schema):
    mode: Literal["bmi", "weight_rule", "iron_deficit"]
    height_cm: str
    weight_kg: str
    bmi: str
    medication: str
    rate_mg_kg: str | None
    basis: Literal["per_dose", "per_day"]
    maximum_mg: str | None
    dose_mg: str | None
    exceeds_maximum: bool
    rule_source: str
    reviewed: bool
    text: str
    iron_deficit_mg: str | None = None
    hb_g_l: str | None = None
    target_hb_g_l: str | None = None
    iron_store_mg: str | None = None


def number(value: Decimal) -> str:
    return format(value.normalize(), "f")


def calculate(body: CalculationInput) -> CalculationResult:
    bmi = (body.weight_kg / (body.height_cm / 100) ** 2).quantize(
        Decimal("0.1"), rounding=ROUND_HALF_UP
    )
    dose = body.weight_kg * body.rate_mg_kg if body.mode == "weight_rule" else None
    exceeds = dose is not None and body.maximum_mg is not None and dose > body.maximum_mg
    height, weight = number(body.height_cm), number(body.weight_kg)
    text = f"Рост {height} см, масса {weight} кг. ИМТ = {weight} / ({height}/100)² = {bmi} кг/м²."
    if dose is not None:
        unit = "на один приём" if body.basis == "per_dose" else "в сутки"
        text += (
            f"\nАрифметическая проверка назначения врача: {body.medication.strip()}. "
            f"{number(body.rate_mg_kg)} мг/кг {unit} × {weight} кг = {number(dose)} мг {unit}. "
            f"Основание правила: {body.rule_source.strip()}."
        )
        if body.maximum_mg is not None:
            text += f" Указанный врачом максимум: {number(body.maximum_mg)} мг {unit}."
        else:
            text += " Максимальная доза не указана; проверка ограничения не выполнена."
    deficit = None
    if body.mode == "iron_deficit":
        deficit = (
            body.weight_kg * (body.target_hb_g_l - body.hb_g_l) * Decimal("0.24")
            + body.iron_store_mg
        )
        text += (
            f"\nРасчёт общего дефицита железа по Ганзони: {weight} × "
            f"({number(body.target_hb_g_l)} − {number(body.hb_g_l)}) г/л × 0,24 + "
            f"{number(body.iron_store_mg)} = {number(deficit)} мг элементарного железа. "
            "Это оценка общей потребности, не разовая/суточная доза и не схема введения."
        )
        if body.medication.strip():
            text += f" Препарат для рассмотрения врачом: {body.medication.strip()}."
        text += " Применимость формулы, препарат и схему врач проверяет отдельно."
    return CalculationResult(
        mode=body.mode,
        height_cm=height,
        weight_kg=weight,
        bmi=str(bmi),
        medication=body.medication.strip(),
        rate_mg_kg=number(body.rate_mg_kg) if body.rate_mg_kg is not None else None,
        basis=body.basis,
        maximum_mg=number(body.maximum_mg) if body.maximum_mg else None,
        dose_mg=number(dose) if dose is not None else None,
        exceeds_maximum=exceeds,
        rule_source=body.rule_source.strip(),
        reviewed=body.reviewed,
        text=text,
        iron_deficit_mg=number(deficit) if deficit is not None else None,
        hb_g_l=number(body.hb_g_l) if body.hb_g_l is not None else None,
        target_hb_g_l=number(body.target_hb_g_l) if body.target_hb_g_l is not None else None,
        iron_store_mg=number(body.iron_store_mg) if body.iron_store_mg is not None else None,
    )


def find_measurements(records) -> list[dict]:
    candidates = []
    patterns = [
        (
            "height_cm",
            r"рост\s*(?:у меня\s*)?(?:[:—=-]|составляет)?\s*"
            r"(\d{1,3}(?:[.,]\d+)?)\s*(см|сантиметр\w*|м(?:етр\w*)?)(?!\w)",
        ),
        (
            "weight_kg",
            r"(?:вес|вешу|масса(?: тела)?)\s*(?:у меня\s*)?(?:[:—=-]|составляет)?\s*"
            r"(\d{1,3}(?:[.,]\d+)?)\s*(кг|килограмм\w*)(?!\w)",
        ),
        (
            "hb_g_l",
            r"(?<!целевой )(?:гемоглобин|hb)\s*[:—=-]?\s*(\d{1,3}(?:[.,]\d+)?)\s*(г/л|г/дл)(?!\w)",
        ),
        (
            "target_hb_g_l",
            r"целевой (?:гемоглобин|hb)\s*[:—=-]?\s*(\d{1,3}(?:[.,]\d+)?)\s*(г/л|г/дл)(?!\w)",
        ),
        (
            "iron_store_mg",
            r"(?:запас железа|депо железа)\s*[:—=-]?\s*(\d{1,4}(?:[.,]\d+)?)\s*(мг)(?!\w)",
        ),
    ]
    for record in records:
        for segment in record.segments:
            # Candidates only. Ambiguous/history/family statements require manual entry.
            if segment.role == "unknown" or re.search(
                r"\?|\b(?:не|раньше|был|была|мам\w*|пап\w*|реб[её]н\w*|доч\w*|сын\w*)\b",
                segment.text.lower(),
            ):
                continue
            for kind, pattern in patterns:
                if kind in {"target_hb_g_l", "iron_store_mg"} and segment.role != "doctor":
                    continue
                for match in re.finditer(pattern, segment.text.lower()):
                    value = Decimal(match[1].replace(",", "."))
                    if kind == "height_cm" and match[2].startswith("м"):
                        value *= 100
                    if kind in {"hb_g_l", "target_hb_g_l"} and match[2] == "г/дл":
                        value *= 10
                    upper = {
                        "height_cm": 300,
                        "weight_kg": 1000,
                        "hb_g_l": 250,
                        "target_hb_g_l": 250,
                        "iron_store_mg": 3000,
                    }[kind]
                    if value <= 0 or value > upper:
                        continue
                    candidates.append(
                        {
                            "kind": kind,
                            "value": number(value),
                            "record_id": str(record.id),
                            "segment_id": str(segment.id),
                            "quote": segment.text,
                            "record_kind": record.kind,
                            "visit_date": str(record.visit_date) if record.visit_date else None,
                        }
                    )
    return candidates


def automatic_calculation(records, revision: int) -> dict:
    """Prefer current measurements, otherwise latest dated historical values.

    Historical values stay explicitly historical; never promote an old prescription
    into a current treatment order. Conflicts are returned, not silently resolved.
    """
    candidates = find_measurements(records)
    selected, missing, conflicts = {}, [], []
    for key in ['height_cm', 'weight_kg', 'hb_g_l', 'target_hb_g_l', 'iron_store_mg']:
        options = [m for m in candidates if m['kind'] == key]
        current = [m for m in options if m['record_kind'] == 'current']
        if current:
            options = current
        else:
            dated = [m for m in options if m['visit_date']]
            if dated:
                latest = max(m['visit_date'] for m in dated)
                options = [m for m in dated if m['visit_date'] == latest]
        if len({m['value'] for m in options}) > 1:
            conflicts.append({'field': key, 'candidates': options})
        elif options:
            selected[key] = options[0]
        else:
            missing.append(key)
    result = None
    if 'height_cm' in selected and 'weight_kg' in selected:
        values = {k: v['value'] for k, v in selected.items()}
        mode = 'iron_deficit' if all(k in selected for k in ['hb_g_l','target_hb_g_l','iron_store_mg']) else 'bmi'
        try:
            result = calculate(CalculationInput(expected_revision=revision, mode=mode, **values)).model_dump()
        except ValueError:
            # Keep a valid BMI even when iron deficit inputs are unsuitable.
            result = calculate(CalculationInput(expected_revision=revision, mode='bmi',
                               height_cm=values['height_cm'], weight_kg=values['weight_kg'])).model_dump()
    return {'result': result, 'sources': list(selected.values()), 'missing': missing,
            'conflicts': conflicts, 'uses_history': any(m['record_kind'] == 'history' for m in selected.values()),
            'dose_status': 'requires_medication_and_current_rule',
            'message': 'Доза требует препарата и актуального правила назначения. ИМТ сам по себе дозу не определяет.'}
