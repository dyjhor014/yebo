# Datos de identidad

## common-passwords.txt.gz

Contraseñas filtradas que la política de contraseñas rechaza (Fase 4.3b, decisión del 2026-11-10: lista local, sin llamadas externas).

- **Origen:** `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` de [SecLists](https://github.com/danielmiessler/SecLists). Licencia MIT, © 2018 Daniel Miessler.
- **Transformación:**
  1. se toman solo las de 10 a 128 caracteres imprimibles, porque las más cortas ya las rechaza la longitud mínima;
  2. se pasan a minúsculas;
  3. se eliminan los duplicados y se ordenan.
- **Tamaño:** 117 571 entradas, comprimidas con `gzip -9 -n`.
- **Regenerar:**

  ```sh
  awk 'length($0)>=10 && length($0)<=128' xato-net-10-million-passwords-1000000.txt | tr -d '\r' \
    | LC_ALL=C grep -v '[^[:print:]]' | tr 'A-Z' 'a-z' | sort -u | gzip -9 -n > common-passwords.txt.gz
  ```

Se copia a `dist` con la opción `assets` de `nest-cli.json`.
