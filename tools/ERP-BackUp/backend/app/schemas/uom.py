from pydantic import BaseModel, ConfigDict
class UOMOut(BaseModel):
    code: str; name: str; dimension: str; is_base: bool; factor_to_base: float
    model_config = ConfigDict(from_attributes=True)
