export function MonoStereoIcon({
  stereo,
  size = 13,
}: {
  stereo: boolean;
  size?: number;
}) {
  if (!stereo) {
    return (
      <span
        className="inline-block shrink-0 rounded-full border-[1.5px] border-current"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size * 1.6, height: size }}
    >
      <span
        className="absolute left-0 top-0 rounded-full border-[1.5px] border-current"
        style={{ width: size, height: size }}
      />
      <span
        className="absolute right-0 top-0 rounded-full border-[1.5px] border-current opacity-60"
        style={{ width: size, height: size }}
      />
    </span>
  );
}
