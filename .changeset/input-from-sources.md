---
"explorer-verify": minor
---

`buildVerifyInputFromSources`, from the new `explorer-verify/sources` entry, builds the verification input from Solidity sources, the compiler settings and the remappings of a build. Use it for a package that ships sources and bytecode but no build-info, Standard JSON input or metadata. It follows the contract's imports as solc resolves them and puts only the files the contract reaches in the input. Pass the sources as an object or as a function that returns each file. An import the sources lack throws `incomplete-input` with the missing names in `details.candidates`. It never compiles, and the default entry does not grow.

The guide "Verify contracts from a package that ships only sources" shows how to read the settings, build the input, compare it with the package's bytecode and ship it.

https://github.com/aelmanaa/explorer-verify/issues/283
