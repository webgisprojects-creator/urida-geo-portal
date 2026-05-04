import React from 'react';
import manifest from '../assets/optimized-manifest.json';

const ResponsiveImage = ({ imageKey, alt, className, sizes = "100vw", style = {}, ...props }) => {
  const image = manifest[imageKey];

  if (!image) {
    console.warn(`Image key "${imageKey}" not found in manifest.`);
    // Return a placeholder or fail gracefully?
    // If the image key is not found, we can try to use the key as a direct src if it's a path,
    // but here we expect keys to be filenames.
    // We'll return a simple img tag with the key as src as a fallback, though it likely won't work if path is wrong.
    return <img src={imageKey} alt={alt} className={className} style={style} {...props} />;
  }

  const { variants, fallback, width, height } = image;
  
  // Generate srcset strings
  const generateSrcSet = (formatVariants) => {
    if (!formatVariants || formatVariants.length === 0) return null;
    return formatVariants.map(v => `${v.src} ${v.width}w`).join(', ');
  };

  const avifSrcSet = generateSrcSet(variants.avif);
  const webpSrcSet = generateSrcSet(variants.webp);
  const jpgSrcSet = generateSrcSet(variants.jpg);

  const fallbackSrc = `/assets/optimized/${fallback}`;

  return (
    <picture style={{ display: 'contents' }}>
      {avifSrcSet && <source type="image/avif" srcSet={avifSrcSet} sizes={sizes} />}
      {webpSrcSet && <source type="image/webp" srcSet={webpSrcSet} sizes={sizes} />}
      {jpgSrcSet && <source type="image/jpeg" srcSet={jpgSrcSet} sizes={sizes} />}
      <img 
        src={fallbackSrc} 
        alt={alt} 
        className={className} 
        style={style}
        loading="lazy" 
        width={width}
        height={height}
        {...props} 
      />
    </picture>
  );
};

export default ResponsiveImage;
