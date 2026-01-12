/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/reward_vault.json`.
 */
export type RewardVault = {
  "address": "programid",
  "metadata": {
    "name": "rewardVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Reward Vault program (Anchor)"
  },
  "instructions": [
    {
      "name": "allocateClaimableRp",
      "discriminator": [
        49,
        119,
        70,
        128,
        93,
        57,
        157,
        106
      ],
      "accounts": [
        {
          "name": "opsAuthority",
          "writable": true,
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "userLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "user_ledger.user",
                "account": "userLedger"
              },
              {
                "kind": "account",
                "path": "ally.nft_mint",
                "account": "allyAccount"
              }
            ]
          }
        },
        {
          "name": "popProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "user_ledger.user",
                "account": "userLedger"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "forcaEquivAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "cancelAllocatedRp",
      "discriminator": [
        217,
        10,
        136,
        224,
        212,
        46,
        133,
        72
      ],
      "accounts": [
        {
          "name": "opsAuthority",
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "userLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "user_ledger.user",
                "account": "userLedger"
              },
              {
                "kind": "account",
                "path": "ally.nft_mint",
                "account": "allyAccount"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "cancelAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimRp",
      "discriminator": [
        89,
        196,
        234,
        5,
        100,
        197,
        24,
        219
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "userAta",
          "writable": true
        },
        {
          "name": "ally",
          "writable": true
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "vaultSigner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  105,
                  103,
                  110,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "allyVaultAta",
          "writable": true
        },
        {
          "name": "userLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "ally.nft_mint",
                "account": "allyAccount"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "popProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "claimGuard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  103,
                  117,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "ally.nft_mint",
                "account": "allyAccount"
              }
            ]
          }
        },
        {
          "name": "pythSolUsdPriceFeed"
        },
        {
          "name": "canonicalPoolForcaSol"
        },
        {
          "name": "mockOracleSol"
        },
        {
          "name": "mockPoolForca"
        },
        {
          "name": "poolForcaReserve"
        },
        {
          "name": "poolSolReserve"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amountForca",
          "type": "u64"
        }
      ]
    },
    {
      "name": "consumePp",
      "discriminator": [
        94,
        196,
        161,
        10,
        61,
        121,
        135,
        210
      ],
      "accounts": [
        {
          "name": "opsAuthority",
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally"
        },
        {
          "name": "userLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "user_ledger.user",
                "account": "userLedger"
              },
              {
                "kind": "account",
                "path": "ally.nft_mint",
                "account": "allyAccount"
              }
            ]
          }
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "amountPpE6",
          "type": "u64"
        }
      ]
    },
    {
      "name": "convertToScopedPp",
      "discriminator": [
        112,
        238,
        195,
        2,
        143,
        214,
        143,
        89
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "userAta",
          "writable": true
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "ally",
          "writable": true
        },
        {
          "name": "nftMint",
          "relations": [
            "ally"
          ]
        },
        {
          "name": "allyVaultAta",
          "writable": true
        },
        {
          "name": "userLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "ally.nft_mint",
                "account": "allyAccount"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "pythSolUsdPriceFeed"
        },
        {
          "name": "canonicalPoolForcaSol"
        },
        {
          "name": "mockOracleSol"
        },
        {
          "name": "mockPoolForca"
        },
        {
          "name": "poolForcaReserve"
        },
        {
          "name": "poolSolReserve"
        }
      ],
      "args": [
        {
          "name": "amountForca",
          "type": "u64"
        },
        {
          "name": "solPriceUsdE6",
          "type": "u64"
        },
        {
          "name": "forcaPerSolE6",
          "type": "u64"
        }
      ]
    },
    {
      "name": "depositForca",
      "discriminator": [
        30,
        240,
        168,
        148,
        164,
        232,
        109,
        154
      ],
      "accounts": [
        {
          "name": "withdrawAuthority",
          "writable": true,
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        },
        {
          "name": "nftMint",
          "relations": [
            "ally"
          ]
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "allyVaultAta",
          "writable": true
        },
        {
          "name": "allyTreasuryAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "grantBonusPp",
      "discriminator": [
        70,
        215,
        17,
        177,
        159,
        141,
        74,
        64
      ],
      "accounts": [
        {
          "name": "opsAuthority",
          "writable": true,
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "user",
          "docs": [
            "The user to receive PP bonus"
          ]
        },
        {
          "name": "userLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "ally.nft_mint",
                "account": "allyAccount"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amountPpE6",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeVault",
      "discriminator": [
        48,
        191,
        163,
        44,
        71,
        129,
        63,
        164
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "vaultSigner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  105,
                  103,
                  110,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "forcaMint"
        },
        {
          "name": "popAdmin",
          "writable": true,
          "signer": true
        },
        {
          "name": "econAdmin",
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feeCBps",
          "type": "u16"
        },
        {
          "name": "taxDBps",
          "type": "u16"
        },
        {
          "name": "marginBBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "registerAlly",
      "discriminator": [
        6,
        244,
        46,
        213,
        31,
        215,
        90,
        111
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "econAdmin",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultState"
          ]
        },
        {
          "name": "forcaMint"
        },
        {
          "name": "vaultSigner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  105,
                  103,
                  110,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "allyNftMint",
          "docs": [
            "Ally identifier NFT mint (any mint acceptable)"
          ]
        },
        {
          "name": "opsAuthority",
          "docs": [
            "operations authority (alloc/consume/etc)"
          ],
          "signer": true
        },
        {
          "name": "withdrawAuthority",
          "docs": [
            "withdraw authority (cold key for vault withdrawals / deposits)"
          ],
          "signer": true
        },
        {
          "name": "allyTreasuryAta",
          "writable": true
        },
        {
          "name": "ally",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "allyNftMint"
              }
            ]
          }
        },
        {
          "name": "allyVaultAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "allyNftMint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "role",
          "type": {
            "defined": {
              "name": "allyRole"
            }
          }
        }
      ]
    },
    {
      "name": "setAllyBenefit",
      "discriminator": [
        255,
        16,
        247,
        163,
        79,
        88,
        19,
        91
      ],
      "accounts": [
        {
          "name": "opsAuthority",
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "mode",
          "type": {
            "defined": {
              "name": "benefitMode"
            }
          }
        },
        {
          "name": "bps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setAllyOpsAuthority",
      "discriminator": [
        111,
        28,
        102,
        51,
        202,
        221,
        91,
        208
      ],
      "accounts": [
        {
          "name": "opsAuthority",
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "newOpsAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setAllyPopEnforcement",
      "discriminator": [
        171,
        101,
        130,
        13,
        212,
        146,
        221,
        157
      ],
      "accounts": [
        {
          "name": "withdrawAuthority",
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "enforce",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setAllyWithdrawAuthority",
      "discriminator": [
        60,
        232,
        136,
        180,
        67,
        179,
        50,
        227
      ],
      "accounts": [
        {
          "name": "withdrawAuthority",
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "newTreasuryAta"
        }
      ],
      "args": [
        {
          "name": "newWithdrawAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setEconAdmin",
      "discriminator": [
        39,
        240,
        4,
        154,
        233,
        71,
        24,
        117
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "econAdmin",
          "signer": true,
          "relations": [
            "vaultState"
          ]
        }
      ],
      "args": [
        {
          "name": "newEconAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setForcaUsd",
      "discriminator": [
        185,
        89,
        128,
        152,
        167,
        24,
        192,
        222
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "popAdmin",
          "signer": true,
          "relations": [
            "vaultState"
          ]
        }
      ],
      "args": [
        {
          "name": "forcaUsdE6",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setMockOracles",
      "discriminator": [
        86,
        112,
        99,
        104,
        15,
        12,
        149,
        226
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "econAdmin",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultState"
          ]
        },
        {
          "name": "mockOracleSol",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  111,
                  99,
                  107,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
                  115,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mockPoolForca",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  111,
                  99,
                  107,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  102,
                  111,
                  114,
                  99,
                  97
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "solUsdE6",
          "type": "u64"
        },
        {
          "name": "forcaPerSolE6",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setOracleConfig",
      "discriminator": [
        96,
        171,
        6,
        98,
        153,
        183,
        233,
        31
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "econAdmin",
          "signer": true,
          "relations": [
            "vaultState"
          ]
        }
      ],
      "args": [
        {
          "name": "verifyPrices",
          "type": "bool"
        },
        {
          "name": "oracleToleranceBps",
          "type": "u16"
        },
        {
          "name": "pythSolUsdPriceFeed",
          "type": "pubkey"
        },
        {
          "name": "canonicalPoolForcaSol",
          "type": "pubkey"
        },
        {
          "name": "canonicalPoolForcaReserve",
          "type": "pubkey"
        },
        {
          "name": "canonicalPoolSolReserve",
          "type": "pubkey"
        },
        {
          "name": "useMockOracle",
          "type": "bool"
        },
        {
          "name": "pythMaxStaleSecs",
          "type": "u64"
        },
        {
          "name": "pythMaxConfidenceBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setParams",
      "discriminator": [
        27,
        234,
        178,
        52,
        147,
        2,
        187,
        141
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "econAdmin",
          "signer": true,
          "relations": [
            "vaultState"
          ]
        }
      ],
      "args": [
        {
          "name": "feeCBps",
          "type": "u16"
        },
        {
          "name": "taxDBps",
          "type": "u16"
        },
        {
          "name": "marginBBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setPause",
      "discriminator": [
        63,
        32,
        154,
        2,
        56,
        103,
        79,
        45
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "econAdmin",
          "signer": true,
          "relations": [
            "vaultState"
          ]
        }
      ],
      "args": [
        {
          "name": "pause",
          "type": "bool"
        },
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "maxDurationSecs",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setPopAdmin",
      "discriminator": [
        76,
        116,
        139,
        33,
        168,
        144,
        223,
        222
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "popAdmin",
          "signer": true,
          "relations": [
            "vaultState"
          ]
        }
      ],
      "args": [
        {
          "name": "newPopAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPopLevel",
      "discriminator": [
        103,
        242,
        55,
        150,
        86,
        166,
        120,
        24
      ],
      "accounts": [
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "popAdmin",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultState"
          ]
        },
        {
          "name": "user",
          "docs": [
            "The user whose POP level is being set"
          ]
        },
        {
          "name": "popProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "level",
          "type": {
            "defined": {
              "name": "popLevel"
            }
          }
        }
      ]
    },
    {
      "name": "setPopParams",
      "discriminator": [
        73,
        114,
        220,
        88,
        130,
        196,
        139,
        42
      ],
      "accounts": [
        {
          "name": "withdrawAuthority",
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "softDailyCapUsdE6",
          "type": "u64"
        },
        {
          "name": "softCooldownSecs",
          "type": "u64"
        },
        {
          "name": "monthlyClaimLimit",
          "type": "u16"
        },
        {
          "name": "hardKycThresholdUsdE6",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawForca",
      "discriminator": [
        53,
        146,
        208,
        249,
        182,
        161,
        181,
        221
      ],
      "accounts": [
        {
          "name": "withdrawAuthority",
          "signer": true,
          "relations": [
            "ally"
          ]
        },
        {
          "name": "ally",
          "writable": true
        },
        {
          "name": "nftMint",
          "relations": [
            "ally"
          ]
        },
        {
          "name": "vaultState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "vaultSigner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  105,
                  103,
                  110,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "allyVaultAta",
          "writable": true
        },
        {
          "name": "allyTreasuryAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "allyAccount",
      "discriminator": [
        117,
        224,
        92,
        88,
        216,
        181,
        214,
        151
      ]
    },
    {
      "name": "claimGuard",
      "discriminator": [
        8,
        69,
        122,
        85,
        29,
        119,
        197,
        90
      ]
    },
    {
      "name": "mockOracleSolUsd",
      "discriminator": [
        80,
        35,
        77,
        41,
        80,
        232,
        205,
        62
      ]
    },
    {
      "name": "mockPoolForcaSol",
      "discriminator": [
        27,
        7,
        12,
        70,
        170,
        234,
        249,
        230
      ]
    },
    {
      "name": "popProfile",
      "discriminator": [
        111,
        170,
        103,
        48,
        170,
        163,
        45,
        178
      ]
    },
    {
      "name": "userLedger",
      "discriminator": [
        185,
        84,
        101,
        128,
        8,
        6,
        160,
        83
      ]
    },
    {
      "name": "vaultState",
      "discriminator": [
        228,
        196,
        82,
        165,
        98,
        210,
        235,
        152
      ]
    }
  ],
  "events": [
    {
      "name": "allocateRpEvent",
      "discriminator": [
        191,
        136,
        245,
        230,
        22,
        184,
        198,
        164
      ]
    },
    {
      "name": "allyBenefitSet",
      "discriminator": [
        237,
        5,
        248,
        221,
        48,
        207,
        46,
        203
      ]
    },
    {
      "name": "allyDepositEvent",
      "discriminator": [
        245,
        224,
        20,
        169,
        18,
        4,
        69,
        109
      ]
    },
    {
      "name": "allyOpsAuthorityUpdated",
      "discriminator": [
        70,
        35,
        171,
        20,
        224,
        205,
        118,
        23
      ]
    },
    {
      "name": "allyPopEnforcementSet",
      "discriminator": [
        78,
        64,
        154,
        15,
        113,
        236,
        143,
        205
      ]
    },
    {
      "name": "allyRegistered",
      "discriminator": [
        157,
        189,
        197,
        228,
        136,
        166,
        160,
        154
      ]
    },
    {
      "name": "allyWithdrawAuthorityUpdated",
      "discriminator": [
        239,
        242,
        31,
        232,
        122,
        102,
        244,
        4
      ]
    },
    {
      "name": "allyWithdrawEvent",
      "discriminator": [
        31,
        92,
        86,
        168,
        117,
        96,
        228,
        80
      ]
    },
    {
      "name": "cancelRpEvent",
      "discriminator": [
        68,
        44,
        161,
        5,
        49,
        217,
        249,
        177
      ]
    },
    {
      "name": "claimRpEvent",
      "discriminator": [
        152,
        194,
        145,
        93,
        155,
        224,
        83,
        217
      ]
    },
    {
      "name": "consumePpEvent",
      "discriminator": [
        174,
        52,
        227,
        69,
        51,
        254,
        36,
        235
      ]
    },
    {
      "name": "convertToPpEvent",
      "discriminator": [
        50,
        9,
        22,
        99,
        146,
        116,
        137,
        131
      ]
    },
    {
      "name": "econAdminUpdated",
      "discriminator": [
        173,
        179,
        118,
        20,
        96,
        131,
        197,
        158
      ]
    },
    {
      "name": "grantBonusPpEvent",
      "discriminator": [
        34,
        125,
        162,
        251,
        187,
        147,
        98,
        148
      ]
    },
    {
      "name": "popAdminUpdated",
      "discriminator": [
        102,
        47,
        33,
        161,
        60,
        233,
        77,
        185
      ]
    },
    {
      "name": "popParamsUpdated",
      "discriminator": [
        237,
        4,
        138,
        210,
        0,
        154,
        105,
        115
      ]
    },
    {
      "name": "vaultInitialized",
      "discriminator": [
        180,
        43,
        207,
        2,
        18,
        71,
        3,
        75
      ]
    },
    {
      "name": "vaultPauseEvent",
      "discriminator": [
        174,
        145,
        176,
        6,
        52,
        202,
        67,
        175
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "Operation paused"
    },
    {
      "code": 6001,
      "name": "overflow",
      "msg": "overflow"
    },
    {
      "code": 6002,
      "name": "invalidBps",
      "msg": "Invalid bps"
    },
    {
      "code": 6003,
      "name": "invalidForcaDecimals",
      "msg": "Invalid FORCA decimals (must be 6)"
    },
    {
      "code": 6004,
      "name": "invalidMint",
      "msg": "Invalid token mint"
    },
    {
      "code": 6005,
      "name": "insufficientAllyBalance",
      "msg": "Insufficient ally balance"
    },
    {
      "code": 6006,
      "name": "insufficientVaultBalance",
      "msg": "Insufficient vault balance"
    },
    {
      "code": 6007,
      "name": "insufficientUnreservedBalance",
      "msg": "Insufficient unreserved balance"
    },
    {
      "code": 6008,
      "name": "insufficientReservedBalance",
      "msg": "Insufficient reserved balance"
    },
    {
      "code": 6009,
      "name": "zeroAmount",
      "msg": "Zero amount not allowed"
    },
    {
      "code": 6010,
      "name": "invalidQuote",
      "msg": "Invalid quote values"
    },
    {
      "code": 6011,
      "name": "insufficientRp",
      "msg": "Insufficient RP allowance"
    },
    {
      "code": 6012,
      "name": "insufficientPp",
      "msg": "Insufficient PP balance"
    },
    {
      "code": 6013,
      "name": "amountTooSmallAfterFee",
      "msg": "Amount too small after fees"
    },
    {
      "code": 6014,
      "name": "invalidTreasury",
      "msg": "Invalid treasury token account"
    },
    {
      "code": 6015,
      "name": "invalidVaultAta",
      "msg": "Invalid vault token account"
    },
    {
      "code": 6016,
      "name": "popDenied",
      "msg": "POP level denies RP allocation"
    },
    {
      "code": 6017,
      "name": "softDailyCapExceeded",
      "msg": "Soft POP daily cap exceeded"
    },
    {
      "code": 6018,
      "name": "cooldownNotElapsed",
      "msg": "Cooldown not elapsed"
    },
    {
      "code": 6019,
      "name": "popCapTooLow",
      "msg": "Soft POP daily cap too low"
    },
    {
      "code": 6020,
      "name": "popCooldownTooHigh",
      "msg": "Soft POP cooldown too high"
    },
    {
      "code": 6021,
      "name": "invalidAuthority",
      "msg": "Invalid authority"
    },
    {
      "code": 6022,
      "name": "oracleMissing",
      "msg": "Oracle proof accounts missing"
    },
    {
      "code": 6023,
      "name": "oracleOutOfTolerance",
      "msg": "Oracle values out of tolerance"
    },
    {
      "code": 6024,
      "name": "oracleKeyMismatch",
      "msg": "Oracle key mismatch"
    },
    {
      "code": 6025,
      "name": "oracleParseFailed",
      "msg": "Oracle parsing failed"
    },
    {
      "code": 6026,
      "name": "oracleStale",
      "msg": "Oracle price is stale"
    },
    {
      "code": 6027,
      "name": "invalidBenefitMode",
      "msg": "Invalid benefit mode value"
    },
    {
      "code": 6028,
      "name": "verifyPricesLocked",
      "msg": "verify_prices cannot be disabled once enabled"
    },
    {
      "code": 6029,
      "name": "invalidPauseReason",
      "msg": "Invalid pause reason code"
    },
    {
      "code": 6030,
      "name": "manualForcaUsdDisabled",
      "msg": "Manual FORCA/USD is only allowed when use_mock_oracle=true"
    },
    {
      "code": 6031,
      "name": "mockOracleLocked",
      "msg": "use_mock_oracle cannot be re-enabled once disabled"
    },
    {
      "code": 6032,
      "name": "monthlyClaimLimitExceeded",
      "msg": "Monthly claim limit exceeded"
    },
    {
      "code": 6033,
      "name": "kycRequired",
      "msg": "KYC required for claim"
    },
    {
      "code": 6034,
      "name": "popMonthlyLimitTooLow",
      "msg": "Monthly claim limit too low"
    },
    {
      "code": 6035,
      "name": "popMonthlyLimitTooHigh",
      "msg": "Monthly claim limit too high"
    },
    {
      "code": 6036,
      "name": "popHardCutTooLow",
      "msg": "KYC threshold too low"
    },
    {
      "code": 6037,
      "name": "oracleConfidenceTooWide",
      "msg": "Oracle confidence interval too wide"
    }
  ],
  "types": [
    {
      "name": "allocateRpEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "forcaEquivAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "allyAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nftMint",
            "type": "pubkey"
          },
          {
            "name": "opsAuthority",
            "type": "pubkey"
          },
          {
            "name": "withdrawAuthority",
            "type": "pubkey"
          },
          {
            "name": "treasuryAta",
            "type": "pubkey"
          },
          {
            "name": "vaultAta",
            "type": "pubkey"
          },
          {
            "name": "role",
            "type": "u8"
          },
          {
            "name": "balanceForca",
            "type": "u64"
          },
          {
            "name": "rpReserved",
            "type": "u64"
          },
          {
            "name": "benefitMode",
            "type": "u8"
          },
          {
            "name": "benefitBps",
            "type": "u16"
          },
          {
            "name": "popEnforced",
            "type": "bool"
          },
          {
            "name": "softDailyCapUsdE6",
            "type": "u64"
          },
          {
            "name": "softCooldownSecs",
            "type": "u64"
          },
          {
            "name": "monthlyClaimLimit",
            "type": "u16"
          },
          {
            "name": "hardKycThresholdUsdE6",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "allyBenefitSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "mode",
            "type": "u8"
          },
          {
            "name": "bps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "allyDepositEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "allyOpsAuthorityUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "oldOpsAuthority",
            "type": "pubkey"
          },
          {
            "name": "newOpsAuthority",
            "type": "pubkey"
          },
          {
            "name": "setTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "allyPopEnforcementSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "popEnforced",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "allyRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "opsAuthority",
            "type": "pubkey"
          },
          {
            "name": "withdrawAuthority",
            "type": "pubkey"
          },
          {
            "name": "role",
            "type": "u8"
          },
          {
            "name": "treasuryAta",
            "type": "pubkey"
          },
          {
            "name": "vaultAta",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "allyRole",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "marketing"
          },
          {
            "name": "dev"
          },
          {
            "name": "other"
          }
        ]
      }
    },
    {
      "name": "allyWithdrawAuthorityUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "oldWithdrawAuthority",
            "type": "pubkey"
          },
          {
            "name": "newWithdrawAuthority",
            "type": "pubkey"
          },
          {
            "name": "oldTreasuryAta",
            "type": "pubkey"
          },
          {
            "name": "newTreasuryAta",
            "type": "pubkey"
          },
          {
            "name": "setTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "allyWithdrawEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "benefitMode",
      "repr": {
        "kind": "rust"
      },
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "none"
          },
          {
            "name": "discount"
          },
          {
            "name": "bonusPp"
          }
        ]
      }
    },
    {
      "name": "cancelRpEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "cancelAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "claimGuard",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "day",
            "type": "i64"
          },
          {
            "name": "usedUsdE6",
            "type": "u64"
          },
          {
            "name": "lastClaimTs",
            "type": "i64"
          },
          {
            "name": "monthIndex",
            "type": "i64"
          },
          {
            "name": "monthClaims",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "claimRpEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "amountForca",
            "type": "u64"
          },
          {
            "name": "net",
            "type": "u64"
          },
          {
            "name": "feeC",
            "type": "u64"
          },
          {
            "name": "taxD",
            "type": "u64"
          },
          {
            "name": "curHwm",
            "type": "u64"
          },
          {
            "name": "newHwm",
            "type": "u64"
          },
          {
            "name": "taxHwm",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "consumePpEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "amountPpE6",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "convertToPpEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "amountForca",
            "type": "u64"
          },
          {
            "name": "marginB",
            "type": "u64"
          },
          {
            "name": "ppDelta",
            "type": "u64"
          },
          {
            "name": "solPriceUsdE6",
            "type": "u64"
          },
          {
            "name": "forcaPerSolE6",
            "type": "u64"
          },
          {
            "name": "pythPriceFeed",
            "type": "pubkey"
          },
          {
            "name": "canonicalPool",
            "type": "pubkey"
          },
          {
            "name": "verifyPrices",
            "type": "bool"
          },
          {
            "name": "oracleToleranceBps",
            "type": "u16"
          },
          {
            "name": "pythExpoI32",
            "type": "i32"
          },
          {
            "name": "pythConfE8",
            "type": "u64"
          },
          {
            "name": "pythPublishTs",
            "type": "i64"
          },
          {
            "name": "curHwm",
            "type": "u64"
          },
          {
            "name": "newHwm",
            "type": "u64"
          },
          {
            "name": "taxHwm",
            "type": "u64"
          },
          {
            "name": "benefitMode",
            "type": "u8"
          },
          {
            "name": "benefitBps",
            "type": "u16"
          },
          {
            "name": "discountForca",
            "type": "u64"
          },
          {
            "name": "bonusPpE6",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "econAdminUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldEconAdmin",
            "type": "pubkey"
          },
          {
            "name": "newEconAdmin",
            "type": "pubkey"
          },
          {
            "name": "setTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "grantBonusPpEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "amountPpE6",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "mockOracleSolUsd",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "solUsdE6",
            "type": "u64"
          },
          {
            "name": "expoI32",
            "type": "i32"
          },
          {
            "name": "confE8",
            "type": "u64"
          },
          {
            "name": "publishTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "mockPoolForcaSol",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "forcaPerSolE6",
            "type": "u64"
          },
          {
            "name": "reserveForcaE6",
            "type": "u64"
          },
          {
            "name": "reserveSolE9",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "popAdminUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldPopAdmin",
            "type": "pubkey"
          },
          {
            "name": "newPopAdmin",
            "type": "pubkey"
          },
          {
            "name": "setTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "popLevel",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "suspicious"
          },
          {
            "name": "soft"
          },
          {
            "name": "strong"
          }
        ]
      }
    },
    {
      "name": "popParamsUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "oldSoftDailyCapUsdE6",
            "type": "u64"
          },
          {
            "name": "oldSoftCooldownSecs",
            "type": "u64"
          },
          {
            "name": "oldMonthlyClaimLimit",
            "type": "u16"
          },
          {
            "name": "oldHardKycThresholdUsdE6",
            "type": "u64"
          },
          {
            "name": "newSoftDailyCapUsdE6",
            "type": "u64"
          },
          {
            "name": "newSoftCooldownSecs",
            "type": "u64"
          },
          {
            "name": "newMonthlyClaimLimit",
            "type": "u16"
          },
          {
            "name": "newHardKycThresholdUsdE6",
            "type": "u64"
          },
          {
            "name": "signer",
            "type": "pubkey"
          },
          {
            "name": "setTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "popProfile",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "level",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "lastSetTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "userLedger",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "allyNftMint",
            "type": "pubkey"
          },
          {
            "name": "rpClaimableForca",
            "type": "u64"
          },
          {
            "name": "ppBalance",
            "type": "u64"
          },
          {
            "name": "hwmClaimed",
            "type": "u64"
          },
          {
            "name": "taxHwm",
            "type": "u64"
          },
          {
            "name": "totalClaimedForca",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "createdTs",
            "type": "i64"
          },
          {
            "name": "updatedTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "forcaMint",
            "type": "pubkey"
          },
          {
            "name": "feeCBps",
            "type": "u16"
          },
          {
            "name": "taxDBps",
            "type": "u16"
          },
          {
            "name": "marginBBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "vaultPauseEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "maxDurationSecs",
            "type": "u64"
          },
          {
            "name": "setTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "popAdmin",
            "type": "pubkey"
          },
          {
            "name": "econAdmin",
            "type": "pubkey"
          },
          {
            "name": "forcaMint",
            "type": "pubkey"
          },
          {
            "name": "feeCBps",
            "type": "u16"
          },
          {
            "name": "taxDBps",
            "type": "u16"
          },
          {
            "name": "marginBBps",
            "type": "u16"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "vaultSignerBump",
            "type": "u8"
          },
          {
            "name": "softDailyCapUsdE6",
            "type": "u64"
          },
          {
            "name": "softCooldownSecs",
            "type": "u64"
          },
          {
            "name": "forcaUsdE6",
            "type": "u64"
          },
          {
            "name": "verifyPrices",
            "type": "bool"
          },
          {
            "name": "oracleToleranceBps",
            "type": "u16"
          },
          {
            "name": "pythSolUsdPriceFeed",
            "type": "pubkey"
          },
          {
            "name": "canonicalPoolForcaSol",
            "type": "pubkey"
          },
          {
            "name": "canonicalPoolForcaReserve",
            "type": "pubkey"
          },
          {
            "name": "canonicalPoolSolReserve",
            "type": "pubkey"
          },
          {
            "name": "useMockOracle",
            "type": "bool"
          },
          {
            "name": "mockOracleLocked",
            "type": "bool"
          },
          {
            "name": "pythMaxStaleSecs",
            "type": "u64"
          },
          {
            "name": "pythMaxConfidenceBps",
            "type": "u16"
          }
        ]
      }
    }
  ]
};
