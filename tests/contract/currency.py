"""The seeded business's currency: the API writes integer centavos with this ISO 4217 code, pey decimal pesos.

Stdlib only, so the fake pey process can import it without the suite's test dependencies.
"""

CURRENCY = "MXN"
CENTAVOS_PER_PESO = 100


def pesos(minor: int) -> float:
    """An amount in centavos as pey writes it."""
    return round(minor / CENTAVOS_PER_PESO, 2)
