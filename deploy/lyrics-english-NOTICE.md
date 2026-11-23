# Optional English Singing Model

Lilt installs these files only in its private offline model runtime, not in its public source or browser bundle.

## Model

- Author: tigermeat (`spicytigermeat`).
- Checkpoint: `tgm_en_v100.ckpt`, [release v1.0.0_en](https://github.com/spicytigermeat/SOFA-Models/releases/tag/v1.0.0_en), August 18, 2024.
- SHA-256: `6aba5f0ba3461155bf0c20190df85fad580de42409784737573309f6962449ff`.
- Upstream description: English singing, American and British accents, ARPAbet with additional `tr`, `dr`, `ax` and `dx` phones; trained with SOFA v1.0.3.
- Upstream permission statement in [SOFA discussion 31](https://github.com/qiuqiao/SOFA/discussions/31):

> Public Use: Approved
> Commercial Use: Approved (You can generate revenue using a voicebank labelled with this model, attribution is not required but is appreciated.)

Upstream reports possible errors for vowel-following `r`, limited high-range/feminine-voice training data and sensitivity to inaccurate dictionary pronunciations. This permission statement is not a license grant for the training recordings or a general redistribution license for all repository contents.

Training providers listed by the author:

| Name | Voice Provider |
| --- | --- |
| A. (Unrevealed) | N. |
| Bitter | Guillotama |
| Canary | Mina Moonrise |
| C.B. (Unrevealed) | M.B. |
| Leif | FerretFather |
| Luther | imsupposedto |
| Miyo | ShiWeiMigi |
| TIGER | tigermeat |
| TRITON | Ryan M. |

## Dictionary

`tgm_sofa_dict.txt` comes from the author's [SOFA-Models repository at ed3218d8233b39cd1dfe7783f03a7e0eaec34597](https://github.com/spicytigermeat/SOFA-Models/blob/ed3218d8233b39cd1dfe7783f03a7e0eaec34597/tgm_sofa_dict.txt), SHA-256 `1b2a52ac559169196cb7cdfd3edcfe3947d37ec6a28a6ec281abac838331439c`. The release identifies this dictionary for the checkpoint. Retain this source and permission record; review dictionary redistribution terms before distributing it outside the owner's installation.
