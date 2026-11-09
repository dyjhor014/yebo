/**
 * Logotipo YEBO para fondos oscuros, según identidad/brand/yebo-logo-oscuro.svg: el isotipo es el archivo de
 * marca SIN modificar (public/brand/yebo-isotipo.svg, copia literal) y el nombre se compone en HTML con las
 * mismas especificaciones del SVG (Manrope 800, interletrado −5/112 ≈ −0,045 em, isotipo ≈ 1,46 × el cuerpo).
 * El margen negativo compensa el aire interno del viewBox (x≈15/240) para alinear ópticamente con el carril.
 * No se usa el SVG completo como imagen porque dentro de <img> no cargaría Manrope y caería a Arial.
 */
export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[0.25em] ${className}`}>
      {/* SVG estático de marca: sin optimización de imagen */}
      <img
        src="/brand/yebo-isotipo.svg"
        alt=""
        width={240}
        height={200}
        className="-ml-[0.11em] h-[1.46em] w-auto"
      />
      <span className="font-display leading-none font-extrabold tracking-[-0.045em]">YEBO</span>
    </span>
  );
}

/** Eslogan de la identidad, con la tipografía y el color del logotipo (Inter 600, teal sobre navy: 8,0:1). */
export function Slogan({ className = '' }: { className?: string }) {
  return <p className={`font-sans font-semibold text-rail-accent ${className}`}>Movemos conexiones.</p>;
}
